import type { HybridSearchDiagnostics } from "@reader/providers";

export interface RerankedCandidateDiagnostic {
    id: string;
    firstStageRank: number;
    chunkIndex: number;
    origin: "first_stage" | "neighbor";
    neighborOf?: string;
}

export interface RerankedFinalCandidateDiagnostic
    extends RerankedCandidateDiagnostic {
    rank: number;
    rerankerRank?: number;
    rerankerScore?: number;
    selectionReason: string;
    maxWordTrigramJaccard: number;
}

export interface RerankedRetrievalDiagnostics {
    mode: "reranked";
    durationMs: number;
    firstStage: HybridSearchDiagnostics;
    firstStageCandidates: RerankedCandidateDiagnostic[];
    finalCandidates: RerankedFinalCandidateDiagnostic[];
    reranker: {
        requestedModel: string;
        resolvedModel: string | null;
        promptVersion: string;
        status: "success" | "skipped" | "fallback";
        durationMs: number;
        usage: MessageModelUsage | null;
        estimatedCost: MessageModelCost | null;
        fallbackReason: string | null;
    };
    diversity: { maxWordTrigramJaccard: number };
}

export type RagRetrievalDiagnostics =
    | HybridSearchDiagnostics
    | RerankedRetrievalDiagnostics;

export interface MessageModelUsage {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

export interface MessageModelCost {
    currency: "USD";
    amount: number;
    pricingVersion: string;
    sourceUrl: string;
}

export interface MessageCombinedCost {
    currency: "USD";
    amount: number;
    pricingVersion: string;
}

export interface RagShadowSourceRank {
    id: string;
    rank: number;
}

export interface RagShadowResult {
    version: "rag-shadow-v1";
    completedAt: string;
    baseline: {
        pipelineVersion: string;
        sources: RagShadowSourceRank[];
        traceId: string | null;
    };
    candidate: {
        pipelineVersion: "rerank-rag-v1";
        sources: RagShadowSourceRank[];
        retrievalDurationMs: number;
        reranker: {
            requestedModel: string;
            resolvedModel: string | null;
            status: "success" | "skipped" | "fallback";
            durationMs: number;
            fallbackReason: string | null;
            usage: MessageModelUsage | null;
            estimatedCost: MessageModelCost | null;
        };
        maxWordTrigramJaccard: number;
        traceId: string | null;
    };
    comparison: {
        overlapCount: number;
        sourceSetJaccard: number;
        exactRankMatches: number;
        identical: boolean;
    };
}

export interface MessageExecutionMetadata {
    pipelineVersion: string;
    promptVersion: string;
    pricingVersion: string;
    modelVersion: string;
    queryPlan: null;
    retrieval: RagRetrievalDiagnostics | null;
    generation: {
        durationMs: number;
        usage: MessageModelUsage | null;
        estimatedCost: MessageModelCost | null;
    };
    retrievalCost: MessageModelCost | null;
    combinedCost: MessageCombinedCost | null;
    totalLatencyMs: number;
    langfuseTraceId: string | null;
    shadow?: RagShadowResult;
}
