import {
    ChatCancelledError,
    type ChatGenerationResult,
    type ChatPromptMessage,
} from "@reader/domain";
import type { Clock } from "../chat/ports";
import type {
    AnswerModelStream,
    RagAnswerModelChunk,
    RagGenerationOptions,
} from "./ports";
import {
    accumulateRagGenerationChunk,
    createRagGenerationState,
    isRagStreamFailure,
    recoverCompletedRagStream,
} from "./policies/generation";

export type GenerateGroundedAnswerInput = RagGenerationOptions & {
    messages: ChatPromptMessage[];
    model: string;
    signal?: AbortSignal;
    onContent?: (content: string) => void | Promise<void>;
    shouldContinue?: () => boolean;
};

export interface GenerateGroundedAnswerDependencies {
    model: AnswerModelStream;
    clock: Clock;
}

const throwIfCancelled = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new ChatCancelledError();
};

const awaitWithCancellation = <T>(
    promise: Promise<T>,
    signal?: AbortSignal
): Promise<T> => {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new ChatCancelledError());
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(new ChatCancelledError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            }
        );
    });
};

export class GenerateGroundedAnswer {
    constructor(private readonly deps: GenerateGroundedAnswerDependencies) {}

    async execute(
        input: GenerateGroundedAnswerInput
    ): Promise<ChatGenerationResult> {
        throwIfCancelled(input.signal);
        const startedAt = this.deps.clock.now().getTime();
        let state = createRagGenerationState(input.model);
        let iterator: AsyncIterator<RagAnswerModelChunk> | undefined;
        let completed = false;
        try {
            iterator = this.deps.model
                .stream({
                    messages: input.messages,
                    model: input.model,
                    signal: input.signal,
                    temperature: input.temperature,
                    langfuse: input.langfuse,
                })
                [Symbol.asyncIterator]();
            while (true) {
                throwIfCancelled(input.signal);
                const next = await awaitWithCancellation(
                    iterator.next(),
                    input.signal
                );
                if (next.done) {
                    completed = true;
                    break;
                }
                if (input.shouldContinue && !input.shouldContinue()) break;
                throwIfCancelled(input.signal);
                state = accumulateRagGenerationChunk(state, next.value);
                if (input.onContent) {
                    await awaitWithCancellation(
                        Promise.resolve(input.onContent(next.value.delta)),
                        input.signal
                    );
                }
                throwIfCancelled(input.signal);
            }
        } catch (error) {
            if (input.signal?.aborted) throw new ChatCancelledError();
            if (isRagStreamFailure(error)) {
                const recovered = recoverCompletedRagStream(state, error);
                if (recovered) {
                    return {
                        ...recovered,
                        durationMs: this.deps.clock.now().getTime() - startedAt,
                    };
                }
            }
            throw error;
        } finally {
            if (!completed && iterator?.return) {
                try {
                    const cleanup = iterator.return();
                    if (input.signal?.aborted) {
                        void Promise.resolve(cleanup).catch(() => undefined);
                    } else {
                        await cleanup;
                    }
                } catch (error) {
                    if (!input.signal?.aborted) throw error;
                }
            }
        }

        throwIfCancelled(input.signal);
        return {
            ...state,
            durationMs: this.deps.clock.now().getTime() - startedAt,
        };
    }
}
