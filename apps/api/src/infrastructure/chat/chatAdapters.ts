import type {
    ChatAnswerGeneration,
    ChatContextRetrieval,
    ChatExecutionMetadataBuilder,
    ChatModelResolver,
    ChatShadowScheduler,
    ChatTraceObservation,
    ChatTracing,
    Clock,
} from "@reader/application";
import {
    OPENAI_CHAT_MODEL,
    OPENAI_CHAT_MAX_TOKENS,
    OPENAI_CHAT_TEMPERATURE,
    isOpenAIChatModel,
    type OpenAIChatModel,
} from "../../services/OpenAIServices";
import {
    generateBookAnswer,
    retrieveBookContext,
} from "../../services/BookRagService";
import {
    getNoopTraceObservation,
    recordObservationError,
    withBookChatTrace,
    type TraceObservation,
} from "../../observability/langfuse";
import { buildMessageExecutionMetadata } from "../../services/ChatExecutionMetadata";
import { maybeEnqueueRagRerankShadow } from "../../services/RagShadowEnqueueService";

const asTrace = (trace: ChatTraceObservation): TraceObservation =>
    trace as unknown as TraceObservation;

export const createChatClock = (): Clock => ({
    now: () => new Date(),
});

export const createChatModelResolver = (): ChatModelResolver => ({
    resolve(model) {
        if (model === undefined || model === null || model === "") {
            return OPENAI_CHAT_MODEL;
        }
        return isOpenAIChatModel(model) ? model : null;
    },
});

export const createChatRetrieval = (
    retrieve: typeof retrieveBookContext = retrieveBookContext
): ChatContextRetrieval => ({
    async retrieve(input, signal) {
        return retrieve({
            bookId: input.bookId,
            userId: input.userId,
            messages: input.messages,
            query: input.query,
            signal,
            highlightContext: input.highlightContext,
            trace: asTrace(input.trace),
        }) as never;
    },
});

export const createChatGeneration = (
    generateAnswer: typeof generateBookAnswer = generateBookAnswer,
    onObservationError: typeof recordObservationError = recordObservationError
): ChatAnswerGeneration => ({
    async generate(input, options) {
        const trace = asTrace(input.trace);
        const openAiSpan = trace.startObservation("openai_chat_stream", {
            input: {
                model: input.model,
                temperature: OPENAI_CHAT_TEMPERATURE,
                maxTokens: OPENAI_CHAT_MAX_TOKENS,
                messageCount: input.messages.length,
            },
        });
        try {
            const generated = await generateAnswer({
                messages: input.messages as never,
                model: input.model as OpenAIChatModel,
                options: {
                    signal: options.signal,
                    langfuse: {
                        userId: input.userId,
                        sessionId: input.conversationId,
                        generationName: "openai_chat_completion",
                        tags: ["reader-api", "book-chat", input.routeName],
                        generationMetadata: {
                            routeName: input.routeName,
                            resourceType: input.resourceType,
                            resourceId: input.resourceId,
                            conversationId: input.conversationId,
                            model: input.model,
                        },
                        parentSpanContext: openAiSpan.getSpanContext(),
                    },
                },
                onContent: options.onContent,
            });
            openAiSpan.update({
                ...(generated.transportWarning
                    ? {
                          level: "WARNING",
                          statusMessage:
                              "Premature close after completed chat stream",
                      }
                    : {}),
                output: {
                    outputLength: generated.answer.length,
                    finishReason: generated.finishReason,
                    streamCompleted: generated.streamCompleted,
                    usage: generated.usage,
                    transportWarning: generated.transportWarning,
                },
            });
            return generated as never;
        } catch (error) {
            onObservationError(openAiSpan, error, "OpenAI chat stream failed");
            throw error;
        } finally {
            openAiSpan.end();
        }
    },
});

export const createChatTracing = (
    runWithTrace: typeof withBookChatTrace = withBookChatTrace
): ChatTracing => ({
    run(meta, fn) {
        return runWithTrace(
            {
                userId: meta.userId,
                conversationId: meta.conversationId,
                resourceType: meta.resourceType,
                resourceId: meta.resourceId,
                routeName: meta.routeName,
                messageCount: meta.messageCount,
                queryLength: meta.queryLength,
                hasHighlightContext: meta.hasHighlightContext,
            },
            fn as never
        ) as never;
    },
});

export const createChatShadowScheduler = (
    enqueue: typeof maybeEnqueueRagRerankShadow = maybeEnqueueRagRerankShadow
): ChatShadowScheduler => ({
    async maybeSchedule(input) {
        await enqueue(input);
    },
});

export const createChatExecutionMetadataBuilder = (
    buildMetadata: typeof buildMessageExecutionMetadata = buildMessageExecutionMetadata
): ChatExecutionMetadataBuilder => ({
    build(input) {
        return buildMetadata({
            telemetry: input.telemetry as never,
            model: input.model,
            usage: input.usage,
            generationDurationMs: input.generationDurationMs,
            totalLatencyMs: input.totalLatencyMs,
            langfuseTraceId: input.langfuseTraceId,
        }) as unknown as Record<string, unknown>;
    },
});

export const createNoopChatTrace = (): ChatTraceObservation =>
    getNoopTraceObservation() as unknown as ChatTraceObservation;
