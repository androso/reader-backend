import type { RagShadowTracing, RagTracing } from "@reader/application";
import {
    getContentFreeTraceObservation,
    withRagShadowTrace,
    type TraceObservation,
} from "../../observability/langfuse";

export const ragShadowTracing: RagShadowTracing = {
    withShadowTrace(context, callback) {
        return withRagShadowTrace(context, (trace) =>
            callback(trace as unknown as RagTracing)
        );
    },
    contentFree(trace) {
        return getContentFreeTraceObservation(
            trace as unknown as TraceObservation
        ) as unknown as RagTracing;
    },
};
