import {
    ChatCancelledError,
    mapFinishReason,
    normalizeEpubHighlight,
    type ChatHighlight,
    type ChatPromptMessage,
    type ChatStreamEvent,
} from "@reader/domain";
import type {
    ChatAnswerGeneration,
    ChatConversationRepository,
    ChatContextRetrieval,
    ChatEventSink,
    ChatExecutionMetadataBuilder,
    ChatMessageRepository,
    ChatShadowScheduler,
    ChatTraceObservation,
    ChatTracing,
    Clock,
} from "./ports";
import { throwIfChatCancelled } from "./throwIfChatCancelled";
import { buildRetrievalQuery } from "../rag/policies/groundedPrompt";

export type RunBookChatInput = {
    userId: string;
    bookId: string;
    conversationId: string;
    userMessageId: string;
    query: string;
    messages: ChatPromptMessage[];
    model: string;
    highlightContext: ChatHighlight | null;
    routeName: string;
    sink: ChatEventSink;
    signal: AbortSignal;
    trace?: ChatTraceObservation;
};

export interface RunBookChatDependencies {
    retrieval: ChatContextRetrieval;
    generation: ChatAnswerGeneration;
    messages: Pick<ChatMessageRepository, "append">;
    conversations: Pick<ChatConversationRepository, "touch">;
    tracing: ChatTracing;
    shadow: ChatShadowScheduler;
    metadata: ChatExecutionMetadataBuilder;
    clock: Clock;
}

const asUsageRecord = (
    usage: Record<string, unknown> | null | undefined
): Record<string, unknown> | null =>
    usage && typeof usage === "object" ? usage : null;

export class RunBookChat {
    constructor(private readonly deps: RunBookChatDependencies) {}

    async execute(input: RunBookChatInput): Promise<void> {
        const run = (trace: ChatTraceObservation) =>
            this.runWithTrace(input, trace);
        if (input.trace) return run(input.trace);

        return this.deps.tracing.run(
            {
                userId: input.userId,
                conversationId: input.conversationId,
                resourceType: "book",
                resourceId: input.bookId,
                routeName: input.routeName,
                messageCount: input.messages.length,
                queryLength: input.query.length,
                hasHighlightContext: Boolean(input.highlightContext),
            },
            run
        );
    }

    private async runWithTrace(
        input: RunBookChatInput,
        trace: ChatTraceObservation
    ): Promise<void> {
        const startedAt = this.deps.clock.now().getTime();
        throwIfChatCancelled(input.signal);

        const retrievalQuery = buildRetrievalQuery(
            input.query,
            input.highlightContext
        );
        const ragResult = await this.deps.retrieval.retrieve(
            {
                bookId: input.bookId,
                userId: input.userId,
                messages: input.messages,
                query: retrievalQuery,
                highlightContext: input.highlightContext,
                trace,
            },
            input.signal
        );
        throwIfChatCancelled(input.signal);

        if (ragResult.status !== "ready") {
            const error =
                ragResult.status === "processing"
                    ? "Document context is still processing. Please try again shortly."
                    : ragResult.status === "ingestion_failed"
                      ? ragResult.error || "Document text processing failed."
                      : ragResult.status === "not_found"
                        ? "Book was not found."
                        : "Book retrieval is temporarily unavailable.";
            const event: ChatStreamEvent = {
                error,
                status:
                    ragResult.status === "ingestion_failed"
                        ? "failed"
                        : ragResult.status,
            };
            trace.setTraceIO({
                output: {
                    status: event.status,
                    ...(ragResult.status === "ingestion_failed"
                        ? { error: ragResult.error }
                        : { error }),
                },
            });
            await input.sink.emit(event);
            await input.sink.complete();
            return;
        }

        const generated = await this.deps.generation.generate(
            {
                messages: ragResult.messages,
                model: input.model,
                userId: input.userId,
                conversationId: input.conversationId,
                resourceType: "book",
                resourceId: input.bookId,
                routeName: input.routeName,
                trace,
            },
            {
                signal: input.signal,
                onContent: async (content) => {
                    throwIfChatCancelled(input.signal);
                    await input.sink.emit({ content });
                },
            }
        );
        throwIfChatCancelled(input.signal);

        const completionStatus = mapFinishReason(generated.finishReason);
        const executionMetadata = this.deps.metadata.build({
            telemetry: ragResult.telemetry,
            model: generated.modelVersion,
            usage: asUsageRecord(generated.usage),
            generationDurationMs: generated.durationMs,
            totalLatencyMs: this.deps.clock.now().getTime() - startedAt,
            langfuseTraceId: trace.traceId,
        });
        const assistantMessage = await this.deps.messages.append({
            conversationId: input.conversationId,
            role: "assistant",
            content: generated.answer,
            contextSources: ragResult.sources,
            completionStatus,
            finishReason: generated.finishReason,
            executionMetadata,
            trace,
            signal: input.signal,
        });
        throwIfChatCancelled(input.signal);
        await this.deps.conversations.touch(
            input.conversationId,
            this.deps.clock.now()
        );
        throwIfChatCancelled(input.signal);

        trace.setTraceIO({
            output: {
                status: "complete",
                assistantResponseLength: generated.answer.length,
                sourceCount: ragResult.sources?.length ?? 0,
                pipelineVersion: executionMetadata.pipelineVersion,
                promptVersion: executionMetadata.promptVersion,
                totalLatencyMs: executionMetadata.totalLatencyMs,
                estimatedCost: (
                    executionMetadata.generation as Record<string, unknown>
                ).estimatedCost,
            },
        });
        if (ragResult.sources?.length) {
            await input.sink.emit({
                type: "sources",
                sources: ragResult.sources,
            });
        }
        await input.sink.emit({
            type: "terminal",
            status: completionStatus,
            finishReason: generated.finishReason,
        });
        await input.sink.complete();

        if (assistantMessage?.id) {
            try {
                await this.deps.shadow.maybeSchedule({
                    assistantMessageId: assistantMessage.id,
                    userMessageId: input.userMessageId,
                    conversationId: input.conversationId,
                    bookId: input.bookId,
                    userId: input.userId,
                    hasHighlightContext: Boolean(input.highlightContext),
                });
            } catch {
                // Shadow adapters log and swallow their own enqueue failures.
            }
        }
    }
}
