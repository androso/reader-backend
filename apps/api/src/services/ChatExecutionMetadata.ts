import { Messages } from "../db/schema";
import type { MessageExecutionMetadata } from "../types/ragTelemetry";
import type { BookContextResult } from "./BookRagService";
import { calculateChatExecutionCosts } from "@reader/application";

export const PUBLIC_MESSAGE_SELECTION = {
    id: Messages.id,
    conversationId: Messages.conversationId,
    role: Messages.role,
    content: Messages.content,
    contextSources: Messages.contextSources,
    completionStatus: Messages.completionStatus,
    finishReason: Messages.finishReason,
    createdAt: Messages.createdAt,
};

export const buildMessageExecutionMetadata = ({
    telemetry,
    model,
    usage,
    generationDurationMs,
    totalLatencyMs,
    langfuseTraceId,
}: {
    telemetry: BookContextResult["telemetry"];
    model: string;
    usage: unknown;
    generationDurationMs: number;
    totalLatencyMs: number;
    langfuseTraceId?: string;
}): MessageExecutionMetadata => {
    const costs = calculateChatExecutionCosts({
        model,
        usage,
        retrieval: telemetry.retrieval as never,
    });
    return {
        pipelineVersion: telemetry.pipelineVersion,
        promptVersion: telemetry.promptVersion,
        pricingVersion: costs.pricingVersion,
        modelVersion: model,
        queryPlan: telemetry.queryPlan,
        retrieval: telemetry.retrieval,
        generation: {
            durationMs: generationDurationMs,
            usage: costs.normalizedUsage,
            estimatedCost: costs.generationCost,
        },
        retrievalCost: costs.retrievalCost,
        combinedCost: costs.combinedCost,
        totalLatencyMs,
        langfuseTraceId: langfuseTraceId ?? null,
    };
};
