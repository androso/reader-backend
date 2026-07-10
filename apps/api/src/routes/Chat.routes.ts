import { and, asc, desc, eq } from "drizzle-orm";
import { createLogger } from "@reader/providers";
import { db } from "../db";
import {
    Books,
    Conversations,
    Messages,
    type MessageContextSource,
} from "../db/schema";
import { authenticate } from "../middleware/auth";
import {
    OPENAI_CHAT_MAX_TOKENS,
    OPENAI_CHAT_MODEL,
    OPENAI_CHAT_TEMPERATURE,
    OpenAIService,
    type ChatMessage,
    type OpenAIChatModel,
    isOpenAIChatModel,
} from "../services/OpenAIServices";
import {
    addHighlightContextMessage,
    buildBookContextSystemPrompt,
    buildRetrievalQuery,
    normalizeHighlightContext,
    type HighlightContext,
} from "../services/HighlightContext";
import { Router, Request, Response } from "express";
import { hybridBookSearchService } from "../services/HybridBookSearchService";
import {
    appendSubmittedUserMessage,
    buildUserMessageInsert,
    getSubmittedUserMessage,
    toChatHistory,
} from "../services/ChatServerHistory";
import {
    getLangfuseCaptureConfig,
    getNoopTraceObservation,
    recordObservationError,
    snippetForLangfuse,
    withBookChatTrace,
    type TraceObservation,
} from "../observability/langfuse";
import {
    authorizeChatResource,
    isSupportedChatResourceType,
} from "../services/ChatResourceAuthorization";

const router = Router();
const oaiService = new OpenAIService();
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

const getErrorDetail = (error: unknown) => {
    if (!error || typeof error !== "object") return String(error);
    const details = error as {
        code?: unknown;
        errno?: unknown;
        message?: unknown;
        name?: unknown;
    };

    return [details.name, details.code, details.errno, details.message]
        .filter(Boolean)
        .join(" ");
};

const isPrematureCloseError = (error: unknown) =>
    getErrorDetail(error).includes("ERR_STREAM_PREMATURE_CLOSE") ||
    getErrorDetail(error).includes("Premature close");

const resolveChatModel = (model: unknown): OpenAIChatModel | null => {
    if (model === undefined || model === null || model === "") {
        return OPENAI_CHAT_MODEL;
    }

    return isOpenAIChatModel(model) ? model : null;
};

const summarizeRetrievedChunks = (
    results: Awaited<ReturnType<typeof hybridBookSearchService.search>>
) => {
    const capture = getLangfuseCaptureConfig();
    return results.map((result) => {
        const snippet = snippetForLangfuse(result.content, capture);
        return {
            id: result.id,
            chunkIndex: result.chunkIndex,
            score: result.score,
            bestRank: result.bestRank,
            ...(snippet ? { snippet } : {}),
        };
    });
};

const buildContextSources = (
    results: Awaited<ReturnType<typeof hybridBookSearchService.search>>
): MessageContextSource[] =>
    results.map((result) => ({
        id: result.id,
        chunkIndex: result.chunkIndex,
        score: result.score,
        bestRank: result.bestRank,
        excerpt: result.content,
    }));

const buildRagMessages = async (
    resourceType: string,
    resourceId: string,
    userId: string,
    messages: ChatMessage[],
    query: string,
    highlightContext: HighlightContext | null = null,
    trace: TraceObservation = getNoopTraceObservation()
): Promise<{
    messages: ChatMessage[];
    status: "ready" | "processing" | "failed";
    sources: MessageContextSource[] | null;
    error?: string | null;
}> => {
    log.debug("Building RAG messages", {
        resourceType,
        resourceId,
        userId,
        query: query.slice(0, 200),
    });
    if (resourceType !== "book") {
        log.debug("Non-book resource, skipping retrieval", {
            resourceType,
            resourceId,
        });
        return {
            messages: addHighlightContextMessage(messages, highlightContext),
            status: "ready",
            sources: null,
        };
    }

    const loadBookSpan = trace.startObservation("load_book", {
        input: {
            resourceType,
            resourceId,
        },
    });
    let book: typeof Books.$inferSelect | undefined;
    try {
        [book] = await db
            .select()
            .from(Books)
            .where(and(eq(Books.id, resourceId), eq(Books.userId, userId)));
        loadBookSpan.update({
            output: {
                found: Boolean(book),
                processingStatus: book?.processingStatus,
                hasCollection: Boolean(book?.collectionName),
                collectionName: book?.collectionName,
                processingError: book?.processingError,
            },
        });
    } catch (error) {
        recordObservationError(loadBookSpan, error, "Book lookup failed");
        throw error;
    } finally {
        loadBookSpan.end();
    }

    if (!book) {
        log.warn("Book not found for RAG", { resourceId, userId });
        return { messages, status: "ready", sources: null };
    }

    if (book.processingStatus === "failed") {
        log.warn("Book processing failed, cannot retrieve context", {
            resourceId,
            userId,
            error: book.processingError,
        });
        return {
            messages,
            status: "failed",
            sources: null,
            error: book.processingError,
        };
    }

    if (!book.collectionName) {
        log.info("Book has no Chroma collection yet", {
            resourceId,
            userId,
            processingStatus: book.processingStatus,
        });
        return { messages, status: "processing", sources: null };
    }

    try {
        log.info("Retrieving book context", {
            resourceId,
            userId,
            collectionName: book.collectionName,
        });
        const start = Date.now();
        const retrievalSpan = trace.startObservation("hybrid_retrieval", {
            input: {
                collectionName: book.collectionName,
                queryLength: query.length,
                lexicalLimit: 20,
                vectorLimit: 20,
                finalLimit: 5,
            },
        });
        let searchResults: Awaited<
            ReturnType<typeof hybridBookSearchService.search>
        >;
        try {
            searchResults = await hybridBookSearchService.search(
                book.collectionName,
                query,
                {},
                {
                    trace: retrievalSpan,
                    capture: getLangfuseCaptureConfig(),
                }
            );
        } catch (error) {
            recordObservationError(
                retrievalSpan,
                error,
                "Hybrid retrieval failed"
            );
            throw error;
        } finally {
            retrievalSpan.end();
        }
        const documents = searchResults.map((result) => result.content);
        const duration = Date.now() - start;
        log.info("Book context retrieved", {
            resourceId,
            collectionName: book.collectionName,
            retrievedChunkCount: documents.length,
            durationMs: duration,
        });

        if (!documents.length) {
            log.warn("No relevant chunks retrieved", {
                resourceId,
                collectionName: book.collectionName,
            });
            return { messages, status: "ready", sources: null };
        }

        const sources = buildContextSources(searchResults);
        const promptSpan = trace.startObservation("build_rag_prompt", {
            input: {
                retrievedChunkCount: documents.length,
                baseMessageCount: messages.length,
            },
        });
        const context = documents.join("\n\n---\n\n");
        log.debug("Constructed context for LLM", {
            resourceId,
            contextLength: context.length,
        });
        promptSpan.update({
            output: {
                contextLength: context.length,
                messageCount: messages.length + 1,
                selectedChunks: summarizeRetrievedChunks(searchResults),
            },
        });
        promptSpan.end();
        return {
            status: "ready",
            sources,
            messages: [
                {
                    role: "system" as const,
                    content: buildBookContextSystemPrompt(
                        context,
                        highlightContext
                    ),
                },
                ...messages,
            ],
        };
    } catch (error) {
        log.error("Error retrieving book context", {
            resourceId,
            collectionName: book.collectionName,
            error: error instanceof Error ? error.message : String(error),
        });
        return { messages, status: "ready", sources: null };
    }
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

    let accumulatedResponse = "";
    let streamCompleted = false;
    let finishReason: string | null = null;
    let usage: unknown;

    try {
        const textStream = await oaiService.generateStreamResponse(
            messages,
            undefined,
            {
                model,
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
            }
        );

        for await (const chunk of textStream) {
            if (res.writableEnded) break;
            const choice = chunk.choices[0];
            if (choice?.finish_reason) {
                finishReason = choice.finish_reason;
            }
            if (choice?.finish_reason === "stop") {
                streamCompleted = true;
            }
            if ("usage" in chunk && chunk.usage) {
                usage = chunk.usage;
            }
            const content = choice?.delta?.content || "";
            accumulatedResponse += content;
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }

        openAiSpan.update({
            output: {
                outputLength: accumulatedResponse.length,
                finishReason,
                streamCompleted,
                usage,
            },
        });
    } catch (streamError) {
        if (!streamCompleted || !isPrematureCloseError(streamError)) {
            recordObservationError(
                openAiSpan,
                streamError,
                "OpenAI chat stream failed"
            );
            throw streamError;
        }

        openAiSpan.update({
            level: "WARNING",
            statusMessage: "Premature close after completed chat stream",
            output: {
                outputLength: accumulatedResponse.length,
                finishReason,
                streamCompleted,
                transportWarning: getErrorDetail(streamError),
                usage,
            },
        });
        log.warn("Ignoring premature close after completed chat stream", {
            conversationId,
            error: getErrorDetail(streamError),
        });
    } finally {
        openAiSpan.end();
    }

    return accumulatedResponse;
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
    const ragResult = await buildRagMessages(
        resourceType,
        resourceId,
        userId,
        messages,
        retrievalQuery,
        highlightContext,
        trace
    );
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
            const authorization = await authorizeRequestResource({
                resourceType: req.params.resourceType,
                resourceId: req.params.id,
                userId: req.user.id,
                res,
            });
            if (!authorization) return;

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");

            const [conversation] = await db
                .insert(Conversations)
                .values({
                    userId: req.user.id,
                    title: message.substring(0, 50) + "...",
                    resourceType: authorization.resourceType,
                    resourceId: req.params.id,
                })
                .returning();

            res.write(
                `data: ${JSON.stringify({ type: "conversation_id", conversationId: conversation.id })}\n\n`
            );

            const messages = appendSubmittedUserMessage([], message);
            await db
                .insert(Messages)
                .values(buildUserMessageInsert(conversation.id, message));
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
