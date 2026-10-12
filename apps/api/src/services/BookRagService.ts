import { type MessageContextSource } from "../db/schema";
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
    snippetForLangfuse,
    type TraceObservation,
} from "../observability/langfuse";
import { getRagPipeline, type RagPipelineVersion } from "./RagPipeline";
import { retrieveBookEvidenceUseCase } from "../infrastructure/rag/composition";
import { getRagMinHybridScore } from "../infrastructure/rag/ragConfig";

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
    return (await retrieveBookEvidenceUseCase.execute({
        bookId,
        userId,
        query,
        signal,
        trace: trace as never,
        strict,
        pipelineVersion,
        minHybridScore: getRagMinHybridScore(),
        strictInfrastructureErrors: strictRerankInfrastructureErrors,
        includeErrorDetailInLogs,
    })) as unknown as Omit<BookContextResult, "messages"> & {
        results?: Awaited<ReturnType<typeof hybridBookSearchService.search>>;
    };
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
    onContent?: (content: string) => void | Promise<void>;
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
            await onContent?.(content);
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
