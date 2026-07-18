import {
    parseRagRerankShadowSampleRate,
    shouldSampleRagRerankShadow,
    type RagRerankShadowJobData,
} from "@reader/jobs";
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
    if (input.hasHighlightContext) return "excluded_highlight" as const;
    let sampleRate: number;
    try {
        sampleRate =
            dependencies.sampleRate ??
            parseRagRerankShadowSampleRate(
                process.env.RAG_RERANK_SHADOW_SAMPLE_RATE
            );
    } catch (error) {
        log.error("RAG shadow sampling configuration is invalid", {
            assistantMessageId: input.assistantMessageId,
            error: error instanceof Error ? error.message : String(error),
        });
        return "invalid_configuration" as const;
    }
    if (
        !shouldSampleRagRerankShadow(
            input.assistantMessageId,
            sampleRate
        )
    ) {
        return "not_sampled" as const;
    }

    const { hasHighlightContext: _hasHighlightContext, ...payload } = input;
    try {
        await dependencies.enqueue(payload);
        log.info("RAG shadow job enqueued", {
            assistantMessageId: payload.assistantMessageId,
            conversationId: payload.conversationId,
            bookId: payload.bookId,
        });
        return "enqueued" as const;
    } catch (error) {
        log.error("RAG shadow enqueue failed", {
            assistantMessageId: payload.assistantMessageId,
            conversationId: payload.conversationId,
            bookId: payload.bookId,
            error: error instanceof Error ? error.message : String(error),
        });
        return "enqueue_failed" as const;
    }
};
