import { type MessageContextSource } from "../db/schema";
import type { HighlightContext } from "./HighlightContext";
import { hybridBookSearchService } from "./HybridBookSearchService";
import {
    type ChatMessage,
    type GenerateStreamResponseOptions,
    type OpenAIService,
    type OpenAIChatModel,
} from "./OpenAIServices";
import {
    getLangfuseCaptureConfig,
    getNoopTraceObservation,
    snippetForLangfuse,
    type TraceObservation,
} from "../observability/langfuse";
import { getRagPipeline, type RagPipelineVersion } from "./RagPipeline";
import {
    createGenerateGroundedAnswer,
    prepareGroundedContextUseCase,
    retrieveBookEvidenceUseCase,
} from "../infrastructure/rag/composition";
import { getRagMinHybridScore } from "../infrastructure/rag/ragConfig";

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
    const prepared = prepareGroundedContextUseCase.execute({
        evidence,
        messages,
        highlightContext,
    });
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
            contextLength: prepared.context?.length ?? 0,
            messageCount: prepared.messages.length,
            selectedChunks: summarizeRetrievedChunks(
                evidence.results,
                getRagPipeline().retrievalStrategy !== "reranked"
            ),
        },
    });
    promptSpan.end();
    getRagPipeline();
    const { results: _results, ...bookContext } = evidence;
    return {
        ...bookContext,
        messages: prepared.messages,
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
    return (await createGenerateGroundedAnswer(service).execute({
        messages: messages as never,
        model,
        signal: options?.signal,
        temperature: options?.temperature,
        langfuse: options?.langfuse as never,
        onContent,
        shouldContinue,
    })) as GeneratedBookAnswer;
};
