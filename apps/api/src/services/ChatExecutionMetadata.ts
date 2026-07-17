import { Messages } from "../db/schema";
import type { MessageExecutionMetadata } from "../types/ragTelemetry";
import type { BookContextResult } from "./BookRagService";
import {
    AI_PRICING_VERSION,
    estimateModelCost,
    normalizeModelUsage,
} from "./AiUsage";

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
    const normalizedUsage = normalizeModelUsage(usage);
    return {
        pipelineVersion: telemetry.pipelineVersion,
        promptVersion: telemetry.promptVersion,
        pricingVersion: AI_PRICING_VERSION,
        modelVersion: model,
        queryPlan: telemetry.queryPlan,
        retrieval: telemetry.retrieval,
        generation: {
            durationMs: generationDurationMs,
            usage: normalizedUsage,
            estimatedCost: estimateModelCost(model, normalizedUsage),
        },
        totalLatencyMs,
        langfuseTraceId: langfuseTraceId ?? null,
    };
};
