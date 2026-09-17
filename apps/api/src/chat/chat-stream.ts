import { HttpException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { createLogger } from "@reader/providers";
import type { Response } from "express";
import type { Database } from "../database/database.module";
import { db } from "../db";
import {
    Conversations,
    Books,
    Messages,
    type MessageContextSource,
} from "../db/schema";
import {
    OPENAI_CHAT_MAX_TOKENS,
    OPENAI_CHAT_MODEL,
    OPENAI_CHAT_TEMPERATURE,
    type ChatMessage,
    type OpenAIChatModel,
    isOpenAIChatModel,
} from "../services/OpenAIServices";
import {
    addHighlightContextMessage,
    buildRetrievalQuery,
    type HighlightContext,
} from "../services/HighlightContext";
import { toChatHistory } from "../services/ChatServerHistory";
import {
    getNoopTraceObservation,
    recordObservationError,
    withBookChatTrace,
    type TraceObservation,
} from "../observability/langfuse";
import {
    generateBookAnswer,
    retrieveBookContext,
} from "../services/BookRagService";
import { authorizeChatResource } from "../services/ChatResourceAuthorization";
import { buildMessageExecutionMetadata } from "../services/ChatExecutionMetadata";
import type { MessageExecutionMetadata } from "../types/ragTelemetry";
import { maybeEnqueueRagRerankShadow } from "../services/RagShadowEnqueueService";

const log = createLogger("chat");

export const CHAT_OPERATIONS = "CHAT_OPERATIONS";

export const createChatResourceRepository = (database: Database) => ({
    findBookById: async (resourceId: string) => {
        const [book] = await database
            .select({
                id: Books.id,
                userId: Books.userId,
            })
            .from(Books)
            .where(eq(Books.id, resourceId));

        return book ?? null;
    },
    createConversation: async ({
        userId,
        title,
        resourceType,
        resourceId,
    }: {
        userId: string;
        title: string;
        resourceType: "book";
        resourceId: string;
    }) => {
        const [conversation] = await database
            .insert(Conversations)
            .values({
                userId,
                title,
                resourceType,
                resourceId,
            })
            .returning({ id: Conversations.id });

        return conversation;
    },
});

export type ChatResourceRepository = ReturnType<
    typeof createChatResourceRepository
>;

export interface ChatStreamDependencies {
    db: Database;
    repository?: ChatResourceRepository;
    authorizeChatResource: typeof authorizeChatResource;
    retrieveBookContext: typeof retrieveBookContext;
    generateBookAnswer: typeof generateBookAnswer;
    maybeEnqueueRagRerankShadow: typeof maybeEnqueueRagRerankShadow;
    withBookChatTrace: typeof withBookChatTrace;
    getNoopTraceObservation: typeof getNoopTraceObservation;
    recordObservationError: typeof recordObservationError;
}

export const resolveChatModel = (model: unknown): OpenAIChatModel | null => {
    if (model === undefined || model === null || model === "") {
        return OPENAI_CHAT_MODEL;
    }

    return isOpenAIChatModel(model) ? model : null;
};

const writeChatStatusAndEnd = (
    res: Response,
    payload: Record<string, unknown>
) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
};

export const createChatOperations = (deps: ChatStreamDependencies) => {
    const database = deps.db;
    const chatResourceRepository =
        deps.repository ?? createChatResourceRepository(database);
    const {
        authorizeChatResource: authorizeResource,
        retrieveBookContext: retrieveContext,
        generateBookAnswer: generateAnswer,
        maybeEnqueueRagRerankShadow,
        withBookChatTrace: bookChatTrace,
        getNoopTraceObservation: noopTraceObservation,
        recordObservationError: recordTraceError,
    } = deps;

    const authorizeRequestResource = async ({
        resourceType,
        resourceId,
        userId,
    }: {
        resourceType: string;
        resourceId: string;
        userId: string;
    }) => {
        const authorization = await authorizeResource({
            resourceType,
            resourceId,
            userId,
            repository: chatResourceRepository,
        });

        if (!authorization.ok) {
            throw new HttpException(
                { error: authorization.error },
                authorization.status
            );
        }

        return authorization;
    };

    const findScopedConversation = async ({
        conversationId,
        userId,
        resourceType,
        resourceId,
    }: {
        conversationId: string;
        userId: string;
        resourceType: "book";
        resourceId: string;
    }) => {
        const [conversation] = await database
            .select()
            .from(Conversations)
            .where(
                and(
                    eq(Conversations.id, conversationId),
                    eq(Conversations.userId, userId),
                    eq(Conversations.resourceType, resourceType),
                    eq(Conversations.resourceId, resourceId)
                )
            );

        return conversation ?? null;
    };

    const touchConversation = async (conversationId: string) => {
        await database
            .update(Conversations)
            .set({ lastMessageAt: new Date() })
            .where(eq(Conversations.id, conversationId));
    };

    const loadConversationHistory = async (
        conversationId: string
    ): Promise<ChatMessage[]> => {
        const rows = await database
            .select({
                role: Messages.role,
                content: Messages.content,
            })
            .from(Messages)
            .where(eq(Messages.conversationId, conversationId))
            .orderBy(asc(Messages.createdAt));

        return toChatHistory(rows);
    };

    const streamAssistantResponse = async ({
        messages,
        res,
        trace,
        userId,
        conversationId,
        resourceType,
        resourceId,
        routeName,
        model,
        traceOpenAI,
        signal,
    }: {
        messages: ChatMessage[];
        res: Response;
        trace: TraceObservation;
        userId: string;
        conversationId: string;
        resourceType: string;
        resourceId: string;
        routeName: string;
        model: OpenAIChatModel;
        traceOpenAI: boolean;
        signal?: AbortSignal;
    }) => {
        const openAiSpan = trace.startObservation("openai_chat_stream", {
            input: {
                model,
                temperature: OPENAI_CHAT_TEMPERATURE,
                maxTokens: OPENAI_CHAT_MAX_TOKENS,
                messageCount: messages.length,
            },
        });

        try {
            const generated = await generateAnswer({
                messages,
                model,
                options: {
                    signal,
                    ...(traceOpenAI
                        ? {
                              langfuse: {
                                  userId,
                                  sessionId: conversationId,
                                  generationName: "openai_chat_completion",
                                  tags: ["reader-api", "book-chat", routeName],
                                  generationMetadata: {
                                      routeName,
                                      resourceType,
                                      resourceId,
                                      conversationId,
                                      model,
                                  },
                                  parentSpanContext:
                                      openAiSpan.getSpanContext(),
                              },
                          }
                        : {}),
                },
                onContent(content) {
                    if (!res.writableEnded) {
                        res.write(`data: ${JSON.stringify({ content })}\n\n`);
                    }
                },
                shouldContinue: () => !res.writableEnded,
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
            return generated;
        } catch (streamError) {
            recordTraceError(
                openAiSpan,
                streamError,
                "OpenAI chat stream failed"
            );
            throw streamError;
        } finally {
            openAiSpan.end();
        }
    };

    const saveAssistantMessage = async (
        conversationId: string,
        content: string,
        contextSources: MessageContextSource[] | null,
        trace: TraceObservation,
        completionStatus: "complete" | "truncated" | "cancelled" | "failed",
        finishReason: string | null,
        executionMetadata: MessageExecutionMetadata
    ) => {
        const saveSpan = trace.startObservation("save_assistant_message", {
            input: {
                conversationId,
                responseLength: content.length,
                sourceCount: contextSources?.length ?? 0,
            },
        });

        try {
            const [message] = await database
                .insert(Messages)
                .values({
                    conversationId,
                    role: "assistant",
                    content,
                    contextSources,
                    completionStatus,
                    finishReason,
                    executionMetadata,
                })
                .returning({ id: Messages.id });
            await touchConversation(conversationId);
            saveSpan.update({
                output: {
                    saved: true,
                    responseLength: content.length,
                    sourceCount: contextSources?.length ?? 0,
                },
            });
            return message;
        } catch (error) {
            recordTraceError(saveSpan, error, "Assistant message save failed");
            throw error;
        } finally {
            saveSpan.end();
        }
    };

    const runChatCompletion = async ({
        resourceType,
        resourceId,
        conversationId,
        userId,
        messages,
        query,
        res,
        routeName,
        model,
        highlightContext,
        trace,
        signal,
        userMessageId,
    }: {
        resourceType: string;
        resourceId: string;
        conversationId: string;
        userId: string;
        messages: ChatMessage[];
        query: string;
        res: Response;
        routeName: string;
        model: OpenAIChatModel;
        highlightContext: HighlightContext | null;
        trace: TraceObservation;
        signal?: AbortSignal;
        userMessageId: string;
    }) => {
        const startedAt = Date.now();
        const retrievalQuery = buildRetrievalQuery(query, highlightContext);
        const ragResult =
            resourceType === "book"
                ? await retrieveContext({
                      bookId: resourceId,
                      userId,
                      messages,
                      query: retrievalQuery,
                      signal,
                      highlightContext,
                      trace,
                  })
                : {
                      messages: addHighlightContextMessage(
                          messages,
                          highlightContext
                      ),
                      status: "ready" as const,
                      sources: null,
                  };
        if (ragResult.status === "processing") {
            trace.setTraceIO({ output: { status: "processing" } });
            writeChatStatusAndEnd(res, {
                error: "Document context is still processing. Please try again shortly.",
                status: "processing",
            });
            return;
        }
        if (ragResult.status === "ingestion_failed") {
            trace.setTraceIO({
                output: { status: "failed", error: ragResult.error },
            });
            writeChatStatusAndEnd(res, {
                error: ragResult.error || "Document text processing failed.",
                status: "failed",
            });
            return;
        }
        if (
            ragResult.status === "not_found" ||
            ragResult.status === "retrieval_unavailable"
        ) {
            const error =
                ragResult.status === "not_found"
                    ? "Book was not found."
                    : "Book retrieval is temporarily unavailable.";
            trace.setTraceIO({ output: { status: ragResult.status, error } });
            writeChatStatusAndEnd(res, { error, status: ragResult.status });
            return;
        }

        const generated = await streamAssistantResponse({
            messages: ragResult.messages,
            res,
            trace,
            userId,
            conversationId,
            resourceType,
            resourceId,
            routeName,
            model,
            traceOpenAI: resourceType === "book",
            signal,
        });

        if (!res.writableEnded) {
            const completionStatus =
                generated.finishReason === "stop"
                    ? "complete"
                    : generated.finishReason === "length"
                      ? "truncated"
                      : "failed";
            const telemetry =
                "telemetry" in ragResult
                    ? ragResult.telemetry
                    : {
                          pipelineVersion: "direct-chat-v1",
                          promptVersion: "helpful-assistant-v1",
                          queryPlan: null,
                          retrieval: null,
                      };
            const executionMetadata = buildMessageExecutionMetadata({
                telemetry,
                model: generated.modelVersion,
                usage: generated.usage,
                generationDurationMs: generated.durationMs,
                totalLatencyMs: Date.now() - startedAt,
                langfuseTraceId: trace.traceId,
            });
            const assistantMessage = await saveAssistantMessage(
                conversationId,
                generated.answer,
                ragResult.sources,
                trace,
                completionStatus,
                generated.finishReason,
                executionMetadata
            );
            trace.setTraceIO({
                output: {
                    status: "complete",
                    assistantResponseLength: generated.answer.length,
                    sourceCount: ragResult.sources?.length ?? 0,
                    pipelineVersion: executionMetadata.pipelineVersion,
                    promptVersion: executionMetadata.promptVersion,
                    totalLatencyMs: executionMetadata.totalLatencyMs,
                    estimatedCost: executionMetadata.generation.estimatedCost,
                },
            });
            if (ragResult.sources?.length) {
                res.write(
                    `data: ${JSON.stringify({ type: "sources", sources: ragResult.sources })}\n\n`
                );
            }
            res.write(
                `data: ${JSON.stringify({ type: "terminal", status: completionStatus, finishReason: generated.finishReason })}\n\n`
            );
            res.write("data: [DONE]\n\n");
            res.end();
            if (resourceType === "book" && assistantMessage) {
                await maybeEnqueueRagRerankShadow({
                    assistantMessageId: assistantMessage.id,
                    userMessageId,
                    conversationId,
                    bookId: resourceId,
                    userId,
                    hasHighlightContext: Boolean(highlightContext),
                });
            }
        }
    };

    const runBookChatTraceIfNeeded = <T>(
        {
            resourceType,
            resourceId,
            conversationId,
            userId,
            routeName,
            messageCount,
            queryLength,
            hasHighlightContext,
        }: {
            resourceType: string;
            resourceId: string;
            conversationId: string;
            userId: string;
            routeName: string;
            messageCount: number;
            queryLength: number;
            hasHighlightContext?: boolean;
        },
        fn: (trace: TraceObservation) => T
    ) => {
        if (resourceType !== "book") return fn(noopTraceObservation());

        return bookChatTrace(
            {
                userId,
                conversationId,
                resourceType,
                resourceId,
                routeName,
                messageCount,
                queryLength,
                hasHighlightContext,
            },
            fn
        );
    };

    return {
        chatResourceRepository,
        authorizeRequestResource,
        findScopedConversation,
        touchConversation,
        loadConversationHistory,
        resolveChatModel,
        runChatCompletion,
        runBookChatTraceIfNeeded,
    };
};

export type ChatOperations = ReturnType<typeof createChatOperations>;

export const defaultChatStreamDependencies: ChatStreamDependencies = {
    db,
    authorizeChatResource,
    retrieveBookContext,
    generateBookAnswer,
    maybeEnqueueRagRerankShadow,
    withBookChatTrace,
    getNoopTraceObservation,
    recordObservationError,
};

export const defaultChatOperations = createChatOperations(
    defaultChatStreamDependencies
);

export const {
    chatResourceRepository,
    authorizeRequestResource,
    findScopedConversation,
    touchConversation,
    loadConversationHistory,
    runChatCompletion,
    runBookChatTraceIfNeeded,
} = defaultChatOperations;
