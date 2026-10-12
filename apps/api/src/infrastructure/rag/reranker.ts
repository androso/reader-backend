import { ChatCancelledError, type RerankerFailure } from "@reader/domain";
import {
    classifyRerankerFallback,
    type Reranker as RerankerPort,
} from "@reader/application";
import { OpenAIChatReranker, type RerankerProvider } from "@reader/providers";

const normalizeFailure = (error: unknown): Error & RerankerFailure => {
    const message = error instanceof Error ? error.message : String(error);
    const failure = new Error(message) as Error & RerankerFailure;
    failure.name = error instanceof Error ? error.name : "RerankerError";
    failure.category = classifyRerankerFallback(error);
    if (error && typeof error === "object") {
        const fields = error as Record<string, unknown>;
        for (const field of [
            "status",
            "code",
            "type",
            "request_id",
            "requestId",
        ]) {
            if (field in fields) {
                Object.defineProperty(failure, field, {
                    value: fields[field],
                    enumerable: true,
                });
            }
        }
    }
    return failure;
};

export const createRagReranker = (
    provider?: RerankerProvider
): RerankerPort => {
    let activeProvider = provider;
    return {
        async rerank(input) {
            if (input.signal?.aborted) throw new ChatCancelledError();
            try {
                activeProvider ??= new OpenAIChatReranker();
                const result = await activeProvider.rerank(input);
                if (input.signal?.aborted) throw new ChatCancelledError();
                return {
                    ...result,
                    usage:
                        result.usage &&
                        typeof result.usage === "object" &&
                        !Array.isArray(result.usage)
                            ? (result.usage as Record<string, unknown>)
                            : null,
                };
            } catch (error) {
                if (input.signal?.aborted) throw new ChatCancelledError();
                if (error instanceof ChatCancelledError) throw error;
                throw normalizeFailure(error);
            }
        },
    };
};

export const ragReranker = createRagReranker();
