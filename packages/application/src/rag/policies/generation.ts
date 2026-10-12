import type { ChatGenerationResult } from "@reader/domain";
import type { RagAnswerModelChunk, RagStreamFailure } from "../ports";

export type RagGenerationState = Omit<ChatGenerationResult, "durationMs">;

export const createRagGenerationState = (
    requestedModel: string
): RagGenerationState => ({
    answer: "",
    modelVersion: requestedModel,
    finishReason: null,
    streamCompleted: false,
    usage: null,
});

export const resolveStreamModelVersion = (
    requestedModel: string,
    streamedModel: unknown
) =>
    typeof streamedModel === "string" && streamedModel
        ? streamedModel
        : requestedModel;

export const accumulateRagGenerationChunk = (
    state: RagGenerationState,
    chunk: RagAnswerModelChunk
): RagGenerationState => ({
    answer: state.answer + chunk.delta,
    modelVersion: resolveStreamModelVersion(
        state.modelVersion,
        chunk.resolvedModel
    ),
    finishReason: chunk.finishReason || state.finishReason,
    streamCompleted: state.streamCompleted || chunk.finishReason === "stop",
    usage: chunk.usage || state.usage,
});

export const isRagStreamFailure = (error: unknown): error is RagStreamFailure =>
    Boolean(
        error &&
            typeof error === "object" &&
            "kind" in error &&
            "message" in error &&
            (error as RagStreamFailure).kind &&
            typeof (error as RagStreamFailure).message === "string"
    );

export const recoverCompletedRagStream = (
    state: RagGenerationState,
    failure: RagStreamFailure
): ChatGenerationResult | null =>
    state.streamCompleted && failure.kind === "premature_close"
        ? {
              ...state,
              durationMs: 0,
              transportWarning: failure.transportWarning ?? failure.message,
          }
        : null;
