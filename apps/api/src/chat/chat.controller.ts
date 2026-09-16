import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpException,
    Inject,
    Param,
    Post,
    Req,
    Res,
    UseGuards,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { ChatRateLimitGuard } from "../common/guards/rate-limit.guard";
import { DRIZZLE, type Database } from "../database/database.module";
import { Conversations, Messages } from "../db/schema";
import { PUBLIC_MESSAGE_SELECTION } from "../services/ChatExecutionMetadata";
import {
    createAuthorizedChatConversation,
    isSupportedChatResourceType,
} from "../services/ChatResourceAuthorization";
import {
    appendSubmittedUserMessage,
    buildUserMessageInsert,
    getSubmittedUserMessage,
} from "../services/ChatServerHistory";
import { normalizeHighlightContext } from "../services/HighlightContext";
import type { User } from "../types";
import {
    authorizeRequestResource,
    chatResourceRepository,
    findScopedConversation,
    loadConversationHistory,
    resolveChatModel,
    runBookChatTraceIfNeeded,
    runChatCompletion,
    touchConversation,
} from "./chat-stream";

type ChatRequestBody = {
    model?: unknown;
    highlightContext?: unknown;
};

@Controller("api")
@UseGuards(AuthGuard)
export class ChatController {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    @Post(":resourceType/:id/conversations")
    @HttpCode(200)
    @UseGuards(ChatRateLimitGuard)
    async createConversation(
        @Req() req: Request,
        @Res() res: Response,
        @Body() body: ChatRequestBody,
        @Param("resourceType") resourceType: string,
        @Param("id") resourceId: string
    ) {
        try {
            const message = getSubmittedUserMessage(body);
            if (!message) {
                throw new HttpException({ error: "Message is required" }, 400);
            }
            const highlightContext = normalizeHighlightContext(
                body?.highlightContext
            );
            const chatModel = resolveChatModel(body?.model);
            if (!chatModel) {
                throw new HttpException(
                    { error: "Unsupported chat model" },
                    400
                );
            }
            const creation = await createAuthorizedChatConversation({
                resourceType,
                resourceId,
                userId: req.user.id,
                title: message.substring(0, 50) + "...",
                repository: chatResourceRepository,
            });
            if (!creation.ok) {
                throw new HttpException(
                    { error: creation.error },
                    creation.status
                );
            }

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");

            const conversation = creation.conversation;

            res.write(
                `data: ${JSON.stringify({ type: "conversation_id", conversationId: conversation.id })}\n\n`
            );

            const messages = appendSubmittedUserMessage([], message);
            const [userMessage] = await this.db
                .insert(Messages)
                .values(buildUserMessageInsert(conversation.id, message))
                .returning({ id: Messages.id });
            await touchConversation(conversation.id);

            const abortController = new AbortController();
            req.once("aborted", () => abortController.abort());

            await runBookChatTraceIfNeeded(
                {
                    resourceType,
                    resourceId,
                    conversationId: conversation.id,
                    userId: req.user.id,
                    routeName: "create_conversation",
                    messageCount: messages.length,
                    queryLength: message.length,
                    hasHighlightContext: Boolean(highlightContext),
                },
                (trace) =>
                    runChatCompletion({
                        resourceType,
                        resourceId,
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
                        userMessageId: userMessage.id,
                    })
            );
        } catch (e) {
            if (e instanceof HttpException) throw e;
            console.error("Error in chat stream", e);
            if (!res.writableEnded) {
                res.write(
                    `data: ${JSON.stringify({ error: "An error occurred" })}\n\n`
                );
                res.end();
            }
        }
    }

    @Get(":resourceType/:id/conversations")
    async listConversations(
        @Param("resourceType") resourceType: string,
        @Param("id") resourceId: string,
        @CurrentUser() user: User
    ) {
        try {
            const authorization = await authorizeRequestResource({
                resourceType,
                resourceId,
                userId: user.id,
            });

            const conversations = await this.db
                .select()
                .from(Conversations)
                .where(
                    and(
                        eq(Conversations.userId, user.id),
                        eq(
                            Conversations.resourceType,
                            authorization.resourceType
                        ),
                        eq(Conversations.resourceId, resourceId)
                    )
                )
                .orderBy(desc(Conversations.lastMessageAt));
            return { conversations };
        } catch (error) {
            if (error instanceof HttpException) throw error;
            console.error("Error fetching conversations", error);
            throw new HttpException(
                { error: "An error occurred while fetching conversations" },
                500
            );
        }
    }

    @Post(":resourceType/:rid/conversations/:cid/messages")
    @HttpCode(200)
    @UseGuards(ChatRateLimitGuard)
    async appendMessage(
        @Req() req: Request,
        @Res() res: Response,
        @Body() body: ChatRequestBody,
        @Param("resourceType") resourceType: string,
        @Param("rid") resourceId: string,
        @Param("cid") conversationId: string
    ) {
        try {
            if (
                !resourceType ||
                !resourceId ||
                !conversationId ||
                !isSupportedChatResourceType(resourceType)
            ) {
                throw new HttpException({ error: "Invalid request" }, 400);
            }

            const message = getSubmittedUserMessage(body);
            if (!message) {
                throw new HttpException({ error: "Message is required" }, 400);
            }
            const highlightContext = normalizeHighlightContext(
                body?.highlightContext
            );
            const chatModel = resolveChatModel(body?.model);
            if (!chatModel) {
                throw new HttpException(
                    { error: "Unsupported chat model" },
                    400
                );
            }
            const authorization = await authorizeRequestResource({
                resourceType,
                resourceId,
                userId: req.user.id,
            });

            const conversation = await findScopedConversation({
                conversationId,
                userId: req.user.id,
                resourceType: authorization.resourceType,
                resourceId,
            });

            if (!conversation) {
                throw new HttpException(
                    { error: "Conversation not found" },
                    404
                );
            }

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");

            const messages = appendSubmittedUserMessage(
                await loadConversationHistory(conversationId),
                message
            );
            const [userMessage] = await this.db
                .insert(Messages)
                .values(buildUserMessageInsert(conversationId, message))
                .returning({ id: Messages.id });
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
                        userMessageId: userMessage.id,
                    })
            );
        } catch (error) {
            if (error instanceof HttpException) throw error;
            console.error("Error in chat messages", error);
            if (!res.writableEnded) {
                res.write(
                    `data: ${JSON.stringify({ error: "An error occurred" })}\n\n`
                );
                res.end();
            }
        }
    }

    @Get(":resourceType/:id/conversations/:conversationId")
    async getConversation(
        @Param("resourceType") resourceType: string,
        @Param("id") resourceId: string,
        @Param("conversationId") conversationId: string,
        @CurrentUser() user: User
    ) {
        try {
            const authorization = await authorizeRequestResource({
                resourceType,
                resourceId,
                userId: user.id,
            });

            const conversation = await findScopedConversation({
                conversationId,
                userId: user.id,
                resourceType: authorization.resourceType,
                resourceId,
            });

            if (!conversation) {
                throw new HttpException(
                    { error: "Conversation not found" },
                    404
                );
            }

            const messages = await this.db
                .select(PUBLIC_MESSAGE_SELECTION)
                .from(Messages)
                .where(eq(Messages.conversationId, conversationId))
                .orderBy(Messages.createdAt);

            return { messages };
        } catch (error) {
            if (error instanceof HttpException) throw error;
            console.error("Error fetching conversation details", error);
            throw new HttpException(
                {
                    error: "An error occurred while retrieving conversation details",
                },
                500
            );
        }
    }
}
