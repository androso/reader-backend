import {
    parseRagRerankShadowSampleRate,
    shouldSampleRagRerankShadow,
    type RagRerankShadowJobData,
} from "@reader/jobs";
import {
    EnqueueRagShadowComparison,
    type RagShadowEnqueueInput as ApplicationRagShadowEnqueueInput,
} from "@reader/application";
import { createLogger } from "@reader/providers";
import { enqueueRagRerankShadow } from "./RagShadowQueue";

const log = createLogger("ragShadowEnqueue");

export type RagShadowEnqueueInput = RagRerankShadowJobData & {
    hasHighlightContext: boolean;
};

export interface RagShadowEnqueueDependencies {
    enqueue(payload: RagRerankShadowJobData): Promise<void>;
    sampleRate?: number;
}

export const maybeEnqueueRagRerankShadow = async (
    input: RagShadowEnqueueInput,
    dependencies: RagShadowEnqueueDependencies = {
        enqueue: enqueueRagRerankShadow,
    }
) => {
    const result = await new EnqueueRagShadowComparison({
        getSampleRate: () =>
            dependencies.sampleRate ??
            parseRagRerankShadowSampleRate(
                process.env.RAG_RERANK_SHADOW_SAMPLE_RATE
            ),
        shouldSample: shouldSampleRagRerankShadow,
        enqueue: dependencies.enqueue,
    }).execute(input as ApplicationRagShadowEnqueueInput);

    if (result.status === "invalid_configuration") {
        log.error("RAG shadow sampling configuration is invalid", {
            assistantMessageId: input.assistantMessageId,
            error:
                result.error instanceof Error
                    ? result.error.message
                    : String(result.error),
        });
        return result.status;
    }
    if (result.status === "enqueue_failed") {
        const { hasHighlightContext: _hasHighlightContext, ...payload } = input;
        log.error("RAG shadow enqueue failed", {
            assistantMessageId: payload.assistantMessageId,
            conversationId: payload.conversationId,
            bookId: payload.bookId,
            error:
                result.error instanceof Error
                    ? result.error.message
                    : String(result.error),
        });
        return result.status;
    }

    if (result.status === "enqueued") {
        log.info("RAG shadow job enqueued", {
            assistantMessageId: input.assistantMessageId,
            conversationId: input.conversationId,
            bookId: input.bookId,
        });
    }
    return result.status;
};
