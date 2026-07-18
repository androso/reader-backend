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
import { getRagPipeline, type RagPipelineVersion } from "./RagPipeline";
import { getRagMinHybridScore } from "./RagRetrievalConfig";
import { retrieveRerankedEvidence } from "./RerankedRetrieval";

const log = createLogger("bookRag");

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
    results: Awaited<ReturnType<typeof hybridBookSearchService.search>>,
    allowSnippets = true
) => {
    const capture = getLangfuseCaptureConfig();
    return results.map((result) => {
        const snippet = allowSnippets
            ? snippetForLangfuse(result.content, capture)
            : undefined;
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
        ...("rerankerRank" in result
            ? { rerankerRank: result.rerankerRank as number }
            : {}),
        ...("rerankerScore" in result
            ? { rerankerScore: result.rerankerScore as number }
            : {}),
        ...("selectionReason" in result
            ? { selectionReason: result.selectionReason as string }
            : {}),
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
        retrieval:
            | import("../types/ragTelemetry").RagRetrievalDiagnostics
            | null;
    };
    error?: string | null;
};

export const retrieveBookEvidence = async ({
    bookId,
    userId,
    query,
    signal,
    trace = getNoopTraceObservation(),
    strict = false,
    pipelineVersion,
    includeErrorDetailInLogs = true,
    strictRerankInfrastructureErrors = false,
}: {
    bookId: string;
    userId: string;
    query: string;
    signal?: AbortSignal;
    trace?: TraceObservation;
    strict?: boolean;
    pipelineVersion?: RagPipelineVersion;
    includeErrorDetailInLogs?: boolean;
    strictRerankInfrastructureErrors?: boolean;
}): Promise<
    Omit<BookContextResult, "messages"> & {
        results?: Awaited<ReturnType<typeof hybridBookSearchService.search>>;
    }
> => {
    const pipeline = getRagPipeline(pipelineVersion);
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
            status: "not_found",
            sources: null,
            telemetry: baseTelemetry,
        };
    }

    if (book.processingStatus === "failed") {
        return {
            status: "ingestion_failed",
            sources: null,
            telemetry: baseTelemetry,
            error: book.processingError,
        };
    }

    if (!book.collectionName) {
        return {
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
        let searchResponse:
            | Awaited<
                  ReturnType<
                      typeof hybridBookSearchService.searchWithDiagnostics
                  >
              >
            | Awaited<ReturnType<typeof retrieveRerankedEvidence>>;
        try {
            searchResponse =
                pipeline.retrievalStrategy === "reranked"
                    ? await retrieveRerankedEvidence({
                          collectionName: book.collectionName,
                          query,
                          minHybridScore: getRagMinHybridScore(),
                          signal,
                          strictInfrastructureErrors:
                              strictRerankInfrastructureErrors,
                      })
                    : await hybridBookSearchService.searchWithDiagnostics(
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
            retrievalSpan.update({ output: searchResponse.diagnostics });
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
            return { status: "ready", sources: null, telemetry, results: [] };
        }

        return {
            status: "ready",
            sources: buildContextSources(searchResults),
            telemetry,
            results: searchResults,
        };
    } catch (error) {
        log.error("Error retrieving book context", {
            bookId,
            collectionName: book.collectionName,
            ...(includeErrorDetailInLogs
                ? {
                      error:
                          error instanceof Error
                              ? error.message
                              : String(error),
                  }
                : {
                      errorName:
                          error instanceof Error ? error.name : typeof error,
                  }),
        });
        if (strict) throw error;
        return {
            status: "retrieval_unavailable",
            sources: null,
            telemetry: baseTelemetry,
            error: "Book retrieval is temporarily unavailable.",
        };
    }
};

export const retrieveBookContext = async ({
    messages,
    highlightContext = null,
    ...options
}: Parameters<typeof retrieveBookEvidence>[0] & {
    messages: ChatMessage[];
    highlightContext?: HighlightContext | null;
}): Promise<BookContextResult> => {
    const evidence = await retrieveBookEvidence(options);
    if (evidence.status !== "ready" || !evidence.results?.length) {
        return { ...evidence, messages };
    }
    const context = evidence.results
        .map((result) => result.content)
        .join("\n\n---\n\n");
    const promptSpan = (
        options.trace ?? getNoopTraceObservation()
    ).startObservation("build_rag_prompt", {
        input: {
            retrievedChunkCount: evidence.results.length,
            baseMessageCount: messages.length,
        },
    });
    promptSpan.update({
        output: {
            contextLength: context.length,
            messageCount: messages.length + 1,
            selectedChunks: summarizeRetrievedChunks(
                evidence.results,
                getRagPipeline().retrievalStrategy !== "reranked"
            ),
        },
    });
    promptSpan.end();
    const { results: _results, ...bookContext } = evidence;
    return {
        ...bookContext,
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
    service,
}: {
    messages: ChatMessage[];
    model: OpenAIChatModel;
    options?: GenerateStreamResponseOptions;
    onContent?: (content: string) => void;
    shouldContinue?: () => boolean;
    service?: OpenAIService;
}): Promise<GeneratedBookAnswer> => {
    const activeService = service ?? new OpenAIService();
    const startedAt = Date.now();
    let answer = "";
    let modelVersion: string = model;
    let streamCompleted = false;
    let finishReason: string | null = null;
    let usage: unknown;

    try {
        const textStream = await activeService.generateStreamResponse(
            messages,
            undefined,
            { ...options, model }
        );

        for await (const chunk of textStream) {
            if (!shouldContinue()) break;
            modelVersion = resolveStreamModelVersion(modelVersion, chunk.model);
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
