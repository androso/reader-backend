import type { HybridSearchDiagnostics } from "@reader/providers";

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

export interface MessageExecutionMetadata {
    pipelineVersion: string;
    promptVersion: string;
    pricingVersion: string;
    modelVersion: string;
    queryPlan: null;
    retrieval: HybridSearchDiagnostics | null;
    generation: {
        durationMs: number;
        usage: MessageModelUsage | null;
        estimatedCost: MessageModelCost | null;
    };
    totalLatencyMs: number;
    langfuseTraceId: string | null;
}
