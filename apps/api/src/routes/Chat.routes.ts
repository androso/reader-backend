import { and, desc, eq } from "drizzle-orm";
import { createLogger } from "@reader/providers";
import { db } from "../db";
import {
    Conversations,
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
import {
    getNoopTraceObservation,
    recordObservationError,
    withBookChatTrace,
    type TraceObservation,
} from "../observability/langfuse";
import { isValidResourceType } from "../services/ConversationScope";
import {
    generateBookAnswer,
    retrieveBookContext,
} from "../services/BookRagService";

const router = Router();
const log = createLogger("chat");

const findScopedConversation = async ({
    conversationId,
    userId,
    resourceType,
    resourceId,
}: {
    conversationId: string;
    userId: string;
    resourceType: "book" | "article";
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
        return generated.answer;
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
    trace: TraceObservation
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
}) => {
    const retrievalQuery = buildRetrievalQuery(query, highlightContext);
    const ragResult =
        resourceType === "book"
            ? await retrieveBookContext({
                  bookId: resourceId,
                  userId,
                  messages,
                  query: retrievalQuery,
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
    if (ragResult.status === "failed") {
        trace.setTraceIO({
            output: { status: "failed", error: ragResult.error },
        });
        writeChatStatusAndEnd(res, {
            error: ragResult.error || "Document text processing failed.",
            status: "failed",
        });
        return;
    }

    const accumulatedResponse = await streamAssistantResponse({
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
    });

    if (!res.writableEnded) {
        await saveAssistantMessage(
            conversationId,
            accumulatedResponse,
            ragResult.sources,
            trace
        );
        trace.setTraceIO({
            output: {
                status: "complete",
                assistantResponseLength: accumulatedResponse.length,
                sourceCount: ragResult.sources?.length ?? 0,
            },
        });
        if (ragResult.sources?.length) {
            res.write(
                `data: ${JSON.stringify({ type: "sources", sources: ragResult.sources })}\n\n`
            );
        }
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
    async (req: Request, res) => {
        if (!isValidResourceType(req.params.resourceType)) {
            res.status(400).send({
                error: "Invalid resource type",
            });
            return;
        }

        try {
            const { message, messages, model } = req.body;
            if (!message || !Array.isArray(messages)) {
                res.status(400).send({
                    error: "Message and messages array are required",
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

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");

            const [conversation] = await db
                .insert(Conversations)
                .values({
                    userId: req.user.id,
                    title: message.substring(0, 50) + "...",
                    resourceType: req.params.resourceType,
                    resourceId: req.params.id,
                })
                .returning();

            res.write(
                `data: ${JSON.stringify({ type: "conversation_id", conversationId: conversation.id })}\n\n`
            );

            await db.insert(Messages).values({
                conversationId: conversation.id,
                role: "user",
                content: message,
            });
            await touchConversation(conversation.id);

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
        if (!isValidResourceType(req.params.resourceType)) {
            res.status(400).send({
                error: "Invalid resource type",
            });
            return;
        }

        try {
            const conversations = await db
                .select()
                .from(Conversations)
                .where(
                    and(
                        eq(Conversations.userId, req.user.id),
                        eq(Conversations.resourceType, req.params.resourceType),
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
                !isValidResourceType(resourceType)
            ) {
                res.status(400).send({
                    error: "Invalid request",
                });
                return;
            }

            const { messages, model } = req.body;
            if (!Array.isArray(messages) || messages.length === 0) {
                res.status(400).send({
                    error: "Messages array is required",
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

            const conversation = await findScopedConversation({
                conversationId,
                userId: req.user.id,
                resourceType,
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

            const lastMessage = messages[messages.length - 1];
            await db.insert(Messages).values({
                conversationId,
                role: lastMessage.role,
                content: lastMessage.content,
            });
            await touchConversation(conversationId);

            await runBookChatTraceIfNeeded(
                {
                    resourceType,
                    resourceId,
                    conversationId,
                    userId: req.user.id,
                    routeName: "append_message",
                    messageCount: messages.length,
                    queryLength: lastMessage.content.length,
                    hasHighlightContext: Boolean(highlightContext),
                },
                (trace) =>
                    runChatCompletion({
                        resourceType,
                        resourceId,
                        conversationId,
                        userId: req.user.id,
                        messages,
                        query: lastMessage.content,
                        res,
                        routeName: "append_message",
                        model: chatModel,
                        highlightContext,
                        trace,
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
        if (!isValidResourceType(req.params.resourceType)) {
            res.status(400).send({
                error: "Invalid resource type",
            });
            return;
        }

        try {
            const conversationId = req.params.conversationId;
            const conversation = await findScopedConversation({
                conversationId,
                userId: req.user.id,
                resourceType: req.params.resourceType,
                resourceId: req.params.id,
            });

            if (!conversation) {
                res.status(404).send({
                    error: "Conversation not found",
                });
                return;
            }

            const messages = await db
                .select()
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
