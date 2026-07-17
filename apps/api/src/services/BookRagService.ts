import { and, eq } from "drizzle-orm";
import { createLogger } from "@reader/providers";
import { db } from "../db";
import { Books, type MessageContextSource } from "../db/schema";
import {
    buildBookContextSystemPrompt,
    type HighlightContext,
} from "./HighlightContext";
import { hybridBookSearchService } from "./HybridBookSearchService";
import {
    OpenAIService,
    resolveStreamModelVersion,
    type ChatMessage,
    type GenerateStreamResponseOptions,
    type OpenAIChatModel,
} from "./OpenAIServices";
import {
    getLangfuseCaptureConfig,
    getNoopTraceObservation,
    recordObservationError,
    snippetForLangfuse,
    type TraceObservation,
} from "../observability/langfuse";
import { getRagPipeline } from "./RagPipeline";

const log = createLogger("bookRag");
const answerService = new OpenAIService();
const DEFAULT_RAG_MIN_HYBRID_SCORE = 0.03;

const getRagMinHybridScore = () => {
    const configured = Number(process.env.RAG_MIN_HYBRID_SCORE);
    return Number.isFinite(configured)
        ? configured
        : DEFAULT_RAG_MIN_HYBRID_SCORE;
};

const getErrorDetail = (error: unknown) => {
    if (!error || typeof error !== "object") return String(error);
    const details = error as {
        code?: unknown;
        errno?: unknown;
        message?: unknown;
        name?: unknown;
    };

    return [details.name, details.code, details.errno, details.message]
        .filter(Boolean)
        .join(" ");
};

const isPrematureCloseError = (error: unknown) =>
    getErrorDetail(error).includes("ERR_STREAM_PREMATURE_CLOSE") ||
    getErrorDetail(error).includes("Premature close");

const summarizeRetrievedChunks = (
    results: Awaited<ReturnType<typeof hybridBookSearchService.search>>
) => {
    const capture = getLangfuseCaptureConfig();
    return results.map((result) => {
        const snippet = snippetForLangfuse(result.content, capture);
        return {
            id: result.id,
            chunkIndex: result.chunkIndex,
            score: result.score,
            bestRank: result.bestRank,
            ...(snippet ? { snippet } : {}),
        };
    });
};

const buildContextSources = (
    results: Awaited<ReturnType<typeof hybridBookSearchService.search>>
): MessageContextSource[] =>
    results.map((result) => ({
        id: result.id,
        chunkIndex: result.chunkIndex,
        score: result.score,
        bestRank: result.bestRank,
        excerpt: result.content,
        metadata: result.metadata,
    }));

export type BookContextResult = {
    messages: ChatMessage[];
    status:
        | "ready"
        | "not_found"
        | "processing"
        | "ingestion_failed"
        | "retrieval_unavailable";
    sources: MessageContextSource[] | null;
    telemetry: {
        pipelineVersion: string;
        promptVersion: string;
        queryPlan: null;
        retrieval: import("@reader/providers").HybridSearchDiagnostics | null;
    };
    error?: string | null;
};

export const retrieveBookContext = async ({
    bookId,
    userId,
    messages,
    query,
    highlightContext = null,
    trace = getNoopTraceObservation(),
    strict = false,
}: {
    bookId: string;
    userId: string;
    messages: ChatMessage[];
    query: string;
    highlightContext?: HighlightContext | null;
    trace?: TraceObservation;
    strict?: boolean;
}): Promise<BookContextResult> => {
    const pipeline = getRagPipeline();
    const baseTelemetry = {
        pipelineVersion: pipeline.pipelineVersion,
        promptVersion: pipeline.promptVersion,
        queryPlan: null,
        retrieval: null,
    };
    const loadBookSpan = trace.startObservation("load_book", {
        input: { resourceType: "book", resourceId: bookId },
    });
    let book: typeof Books.$inferSelect | undefined;
    try {
        [book] = await db
            .select()
            .from(Books)
            .where(and(eq(Books.id, bookId), eq(Books.userId, userId)));
        loadBookSpan.update({
            output: {
                found: Boolean(book),
                processingStatus: book?.processingStatus,
                hasCollection: Boolean(book?.collectionName),
                collectionName: book?.collectionName,
                processingError: book?.processingError,
            },
        });
    } catch (error) {
        recordObservationError(loadBookSpan, error, "Book lookup failed");
        throw error;
    } finally {
        loadBookSpan.end();
    }

    if (!book) {
        log.warn("Book not found for RAG", { bookId, userId });
        return {
            messages,
            status: "not_found",
            sources: null,
            telemetry: baseTelemetry,
        };
    }

    if (book.processingStatus === "failed") {
        return {
            messages,
            status: "ingestion_failed",
            sources: null,
            telemetry: baseTelemetry,
            error: book.processingError,
        };
    }

    if (!book.collectionName) {
        return {
            messages,
            status: "processing",
            sources: null,
            telemetry: baseTelemetry,
        };
    }

    try {
        const retrievalSpan = trace.startObservation("hybrid_retrieval", {
            input: {
                collectionName: book.collectionName,
                queryLength: query.length,
                lexicalLimit: 20,
                vectorLimit: 20,
                finalLimit: 5,
            },
        });
        let searchResponse: Awaited<
            ReturnType<typeof hybridBookSearchService.searchWithDiagnostics>
        >;
        try {
            searchResponse =
                await hybridBookSearchService.searchWithDiagnostics(
                book.collectionName,
                query,
                {
                    minScore: getRagMinHybridScore(),
                },
                {
                    trace: retrievalSpan,
                    capture: getLangfuseCaptureConfig(),
                }
                );
        } catch (error) {
            recordObservationError(
                retrievalSpan,
                error,
                "Hybrid retrieval failed"
            );
            throw error;
        } finally {
            retrievalSpan.end();
        }

        const searchResults = searchResponse.results;
        const telemetry = {
            ...baseTelemetry,
            retrieval: searchResponse.diagnostics,
        };

        if (!searchResults.length) {
            return { messages, status: "ready", sources: null, telemetry };
        }

        const context = searchResults
            .map((result) => result.content)
            .join("\n\n---\n\n");
        const promptSpan = trace.startObservation("build_rag_prompt", {
            input: {
                retrievedChunkCount: searchResults.length,
                baseMessageCount: messages.length,
            },
        });
        promptSpan.update({
            output: {
                contextLength: context.length,
                messageCount: messages.length + 1,
                selectedChunks: summarizeRetrievedChunks(searchResults),
            },
        });
        promptSpan.end();

        return {
            status: "ready",
            sources: buildContextSources(searchResults),
            telemetry,
            messages: [
                {
                    role: "system",
                    content: buildBookContextSystemPrompt(
                        context,
                        highlightContext
                    ),
                },
                ...messages,
            ],
        };
    } catch (error) {
        log.error("Error retrieving book context", {
            bookId,
            collectionName: book.collectionName,
            error: error instanceof Error ? error.message : String(error),
        });
        if (strict) throw error;
        return {
            messages,
            status: "retrieval_unavailable",
            sources: null,
            telemetry: baseTelemetry,
            error: "Book retrieval is temporarily unavailable.",
        };
    }
};

export type GeneratedBookAnswer = {
    answer: string;
    modelVersion: string;
    finishReason: string | null;
    streamCompleted: boolean;
    usage: unknown;
    durationMs: number;
    transportWarning?: string;
};

export const generateBookAnswer = async ({
    messages,
    model,
    options,
    onContent,
    shouldContinue = () => true,
    service = answerService,
}: {
    messages: ChatMessage[];
    model: OpenAIChatModel;
    options?: GenerateStreamResponseOptions;
    onContent?: (content: string) => void;
    shouldContinue?: () => boolean;
    service?: OpenAIService;
}): Promise<GeneratedBookAnswer> => {
    const startedAt = Date.now();
    let answer = "";
    let modelVersion: string = model;
    let streamCompleted = false;
    let finishReason: string | null = null;
    let usage: unknown;

    try {
        const textStream = await service.generateStreamResponse(
            messages,
            undefined,
            { ...options, model }
        );

        for await (const chunk of textStream) {
            if (!shouldContinue()) break;
            modelVersion = resolveStreamModelVersion(
                modelVersion,
                chunk.model
            );
            const choice = chunk.choices[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (choice?.finish_reason === "stop") streamCompleted = true;
            if ("usage" in chunk && chunk.usage) usage = chunk.usage;
            const content = choice?.delta?.content || "";
            answer += content;
            onContent?.(content);
        }
    } catch (error) {
        if (!streamCompleted || !isPrematureCloseError(error)) throw error;

        return {
            answer,
            modelVersion,
            finishReason,
            streamCompleted,
            usage,
            durationMs: Date.now() - startedAt,
            transportWarning: getErrorDetail(error),
        };
    }

    return {
        answer,
        modelVersion,
        finishReason,
        streamCompleted,
        usage,
        durationMs: Date.now() - startedAt,
    };
};
