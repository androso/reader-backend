import { and, asc, desc, eq } from "drizzle-orm";
import { createLogger } from "@reader/providers";
import { db } from "../db";
import {
    Conversations,
    Books,
    Messages,
    type MessageContextSource,
} from "../db/schema";
import { authenticate } from "../middleware/auth";
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
    normalizeHighlightContext,
    type HighlightContext,
} from "../services/HighlightContext";
import { Router, Request, Response } from "express";
import { chatRateLimit } from "../middleware/rateLimit";
import {
    appendSubmittedUserMessage,
    buildUserMessageInsert,
    getSubmittedUserMessage,
    toChatHistory,
} from "../services/ChatServerHistory";
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
import {
    authorizeChatResource,
    createAuthorizedChatConversation,
    isSupportedChatResourceType,
} from "../services/ChatResourceAuthorization";
import {
    buildMessageExecutionMetadata,
    PUBLIC_MESSAGE_SELECTION,
} from "../services/ChatExecutionMetadata";
import type { MessageExecutionMetadata } from "../types/ragTelemetry";

const router = Router();
const log = createLogger("chat");

const chatResourceRepository = {
    findBookById: async (resourceId: string) => {
        const [book] = await db
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
        const [conversation] = await db
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
};

const authorizeRequestResource = async ({
    resourceType,
    resourceId,
    userId,
    res,
}: {
    resourceType: string;
    resourceId: string;
    userId: string;
    res: Response;
}) => {
    const authorization = await authorizeChatResource({
        resourceType,
        resourceId,
        userId,
        repository: chatResourceRepository,
    });

    if (!authorization.ok) {
        res.status(authorization.status).send({
            error: authorization.error,
        });
        return null;
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
    const [conversation] = await db
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
    await db
        .update(Conversations)
        .set({ lastMessageAt: new Date() })
        .where(eq(Conversations.id, conversationId));
};

const loadConversationHistory = async (
    conversationId: string
): Promise<ChatMessage[]> => {
    const rows = await db
        .select({
            role: Messages.role,
            content: Messages.content,
        })
        .from(Messages)
        .where(eq(Messages.conversationId, conversationId))
        .orderBy(asc(Messages.createdAt));

    return toChatHistory(rows);
};
const resolveChatModel = (model: unknown): OpenAIChatModel | null => {
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
        const generated = await generateBookAnswer({
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
                              parentSpanContext: openAiSpan.getSpanContext(),
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
        recordObservationError(
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
        await db.insert(Messages).values({
            conversationId,
            role: "assistant",
            content,
            contextSources,
            completionStatus,
            finishReason,
            executionMetadata,
        });
        await touchConversation(conversationId);
        saveSpan.update({
            output: {
                saved: true,
                responseLength: content.length,
                sourceCount: contextSources?.length ?? 0,
            },
        });
    } catch (error) {
        recordObservationError(
            saveSpan,
            error,
            "Assistant message save failed"
        );
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
}) => {
    const startedAt = Date.now();
    const retrievalQuery = buildRetrievalQuery(query, highlightContext);
    const ragResult =
        resourceType === "book"
            ? await retrieveBookContext({
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
        await saveAssistantMessage(
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
    if (resourceType !== "book") return fn(getNoopTraceObservation());

    return withBookChatTrace(
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

router.post(
    "/:resourceType/:id/conversations",
    authenticate,
    chatRateLimit,
    async (req: Request, res) => {
        try {
            const { model } = req.body;
            const message = getSubmittedUserMessage(req.body);
            if (!message) {
                res.status(400).send({
                    error: "Message is required",
                });
                return;
            }
            const highlightContext = normalizeHighlightContext(
                req.body.highlightContext
            );
            const chatModel = resolveChatModel(model);
            if (!chatModel) {
                res.status(400).send({
                    error: "Unsupported chat model",
                });
                return;
            }
            const creation = await createAuthorizedChatConversation({
                resourceType: req.params.resourceType,
                resourceId: req.params.id,
                userId: req.user.id,
                title: message.substring(0, 50) + "...",
                repository: chatResourceRepository,
            });
            if (!creation.ok) {
                res.status(creation.status).send({ error: creation.error });
                return;
            }

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");

            const conversation = creation.conversation;

            res.write(
                `data: ${JSON.stringify({ type: "conversation_id", conversationId: conversation.id })}\n\n`
            );

            const messages = appendSubmittedUserMessage([], message);
            await db
                .insert(Messages)
                .values(buildUserMessageInsert(conversation.id, message));
            await touchConversation(conversation.id);

            const abortController = new AbortController();
            req.once("aborted", () => abortController.abort());

            await runBookChatTraceIfNeeded(
                {
                    resourceType: req.params.resourceType,
                    resourceId: req.params.id,
                    conversationId: conversation.id,
                    userId: req.user.id,
                    routeName: "create_conversation",
                    messageCount: messages.length,
                    queryLength: message.length,
                    hasHighlightContext: Boolean(highlightContext),
                },
                (trace) =>
                    runChatCompletion({
                        resourceType: req.params.resourceType,
                        resourceId: req.params.id,
                        conversationId: conversation.id,
                        userId: req.user.id,
                        messages,
                        query: message,
                        res,
                        routeName: "create_conversation",
                        model: chatModel,
                        highlightContext,
                        trace,
                        signal: abortController.signal,
                    })
            );
        } catch (e) {
            console.error("Error in chat stream", e);
            if (!res.writableEnded) {
                res.write(
                    `data: ${JSON.stringify({ error: "An error occurred" })}\n\n`
                );
                res.end();
            }
        }
    }
);

router.get(
    "/:resourceType/:id/conversations",
    authenticate,
    async (req: Request, res) => {
        try {
            const authorization = await authorizeRequestResource({
                resourceType: req.params.resourceType,
                resourceId: req.params.id,
                userId: req.user.id,
                res,
            });
            if (!authorization) return;

            const conversations = await db
                .select()
                .from(Conversations)
                .where(
                    and(
                        eq(Conversations.userId, req.user.id),
                        eq(
                            Conversations.resourceType,
                            authorization.resourceType
                        ),
                        eq(Conversations.resourceId, req.params.id)
                    )
                )
                .orderBy(desc(Conversations.lastMessageAt));
            res.status(200).send({
                conversations,
            });
        } catch (error) {
            console.error("Error fetching conversations", error);
            if (!res.headersSent) {
                res.status(500).send({
                    error: "An error occurred while fetching conversations",
                });
            }
        }
    }
);

router.post(
    "/:resourceType/:rid/conversations/:cid/messages",
    authenticate,
    chatRateLimit,
    async (req, res) => {
        try {
            const {
                resourceType,
                rid: resourceId,
                cid: conversationId,
            } = req.params;
            if (
                !resourceType ||
                !resourceId ||
                !conversationId ||
                !isSupportedChatResourceType(resourceType)
            ) {
                res.status(400).send({
                    error: "Invalid request",
                });
                return;
            }

            const { model } = req.body;
            const message = getSubmittedUserMessage(req.body);
            if (!message) {
                res.status(400).send({
                    error: "Message is required",
                });
                return;
            }
            const highlightContext = normalizeHighlightContext(
                req.body.highlightContext
            );
            const chatModel = resolveChatModel(model);
            if (!chatModel) {
                res.status(400).send({
                    error: "Unsupported chat model",
                });
                return;
            }
            const authorization = await authorizeRequestResource({
                resourceType,
                resourceId,
                userId: req.user.id,
                res,
            });
            if (!authorization) return;

            const conversation = await findScopedConversation({
                conversationId,
                userId: req.user.id,
                resourceType: authorization.resourceType,
                resourceId,
            });

            if (!conversation) {
                res.status(404).send({
                    error: "Conversation not found",
                });
                return;
            }

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");

            const messages = appendSubmittedUserMessage(
                await loadConversationHistory(conversationId),
                message
            );
            await db
                .insert(Messages)
                .values(buildUserMessageInsert(conversationId, message));
            await touchConversation(conversationId);

            const abortController = new AbortController();
            req.once("aborted", () => abortController.abort());

            await runBookChatTraceIfNeeded(
                {
                    resourceType,
                    resourceId,
                    conversationId,
                    userId: req.user.id,
                    routeName: "append_message",
                    messageCount: messages.length,
                    queryLength: message.length,
                    hasHighlightContext: Boolean(highlightContext),
                },
                (trace) =>
                    runChatCompletion({
                        resourceType,
                        resourceId,
                        conversationId,
                        userId: req.user.id,
                        messages,
                        query: message,
                        res,
                        routeName: "append_message",
                        model: chatModel,
                        highlightContext,
                        trace,
                        signal: abortController.signal,
                    })
            );
        } catch (error) {
            console.error("Error in chat messages", error);
            if (!res.writableEnded) {
                res.write(
                    `data: ${JSON.stringify({ error: "An error occurred" })}\n\n`
                );
                res.end();
            }
        }
    }
);

router.get(
    "/:resourceType/:id/conversations/:conversationId",
    authenticate,
    async (req: Request, res) => {
        try {
            const authorization = await authorizeRequestResource({
                resourceType: req.params.resourceType,
                resourceId: req.params.id,
                userId: req.user.id,
                res,
            });
            if (!authorization) return;

            const conversationId = req.params.conversationId;
            const conversation = await findScopedConversation({
                conversationId,
                userId: req.user.id,
                resourceType: authorization.resourceType,
                resourceId: req.params.id,
            });

            if (!conversation) {
                res.status(404).send({
                    error: "Conversation not found",
                });
                return;
            }

            const messages = await db
                .select(PUBLIC_MESSAGE_SELECTION)
                .from(Messages)
                .where(eq(Messages.conversationId, conversationId))
                .orderBy(Messages.createdAt);

            res.send({
                messages,
            });
        } catch (error) {
            console.error("Error fetching conversation details", error);
            if (!res.headersSent) {
                res.status(500).send({
                    error: "An error occurred while retrieving conversation details",
                });
            }
        }
    }
);

export default router;
