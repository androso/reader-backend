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
}
