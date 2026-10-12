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
import {
    ChatConversationNotFoundError,
    ChatResourceAccessDeniedError,
    ChatResourceNotFoundError,
    ChatValidationError,
} from "@reader/domain";
import { ChatCancelledError } from "@reader/domain";
import {
    AppendBookChat,
    GetBookConversation,
    ListBookConversations,
    StartBookChat,
} from "@reader/application";
import type { Request, Response } from "express";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { ChatRateLimitGuard } from "../common/guards/rate-limit.guard";
import type { User } from "../types";
import {
    APPEND_BOOK_CHAT,
    GET_BOOK_CONVERSATION,
    LIST_BOOK_CONVERSATIONS,
    START_BOOK_CHAT,
} from "../infrastructure/chat/chat.tokens";
import {
    createSseChatSession,
    type SseChatSession,
} from "../infrastructure/chat/sseChatSession";

type ChatRequestBody = {
    message?: unknown;
    model?: unknown;
    highlightContext?: unknown;
};

const mapChatReadError = (error: unknown): HttpException | null => {
    if (error instanceof ChatValidationError) {
        return new HttpException({ error: error.message }, 400);
    }
    if (error instanceof ChatResourceNotFoundError) {
        return new HttpException({ error: error.message }, 404);
    }
    if (error instanceof ChatResourceAccessDeniedError) {
        return new HttpException({ error: error.message }, 403);
    }
    if (error instanceof ChatConversationNotFoundError) {
        return new HttpException({ error: error.message }, 404);
    }
    return null;
};

@Controller("api")
@UseGuards(AuthGuard)
export class ChatController {
    constructor(
        @Inject(START_BOOK_CHAT)
        private readonly startBookChat: StartBookChat,
        @Inject(APPEND_BOOK_CHAT)
        private readonly appendBookChat: AppendBookChat,
        @Inject(LIST_BOOK_CONVERSATIONS)
        private readonly listBookConversations: ListBookConversations,
        @Inject(GET_BOOK_CONVERSATION)
        private readonly getBookConversation: GetBookConversation
    ) {}

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
        const session = createSseChatSession(req, res);
        let opened = false;
        try {
            if (session.signal.aborted) return;
            const prepared = await this.startBookChat.prepare({
                userId: req.user.id,
                resourceType,
                resourceId,
                message: body?.message,
                model: body?.model,
                highlightContext: body?.highlightContext,
            });
            if (session.signal.aborted) return;
            session.open();
            opened = true;
            await this.startBookChat.executePrepared({
                prepared,
                sink: session.sink,
                signal: session.signal,
                routeName: "create_conversation",
            });
        } catch (error) {
            if (error instanceof ChatCancelledError || session.signal.aborted) {
                return;
            }
            if (!opened) {
                const mapped = mapChatReadError(error);
                if (mapped) throw mapped;
            }
            if (error instanceof HttpException) throw error;
            console.error("Error in chat stream", error);
            if (!opened) {
                throw new HttpException({ error: "An error occurred" }, 500);
            }
            try {
                await session.fail({ error: "An error occurred" });
            } catch (failError) {
                if (
                    failError instanceof ChatCancelledError ||
                    session.signal.aborted
                ) {
                    return;
                }
                throw failError;
            }
        } finally {
            session.dispose();
        }
    }

    @Get(":resourceType/:id/conversations")
    async listConversations(
        @Param("resourceType") resourceType: string,
        @Param("id") resourceId: string,
        @CurrentUser() user: User
    ) {
        try {
            const conversations = await this.listBookConversations.execute({
                userId: user.id,
                resourceType,
                resourceId,
            });
            return { conversations };
        } catch (error) {
            const mapped = mapChatReadError(error);
            if (mapped) throw mapped;
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
        const session = createSseChatSession(req, res);
        let opened = false;
        try {
            if (session.signal.aborted) return;
            const prepared = await this.appendBookChat.prepare({
                userId: req.user.id,
                resourceType,
                resourceId,
                conversationId,
                message: body?.message,
                model: body?.model,
                highlightContext: body?.highlightContext,
            });
            if (session.signal.aborted) return;
            session.open();
            opened = true;
            await this.appendBookChat.executePrepared({
                prepared,
                sink: session.sink,
                signal: session.signal,
                routeName: "append_message",
            });
        } catch (error) {
            if (error instanceof ChatCancelledError || session.signal.aborted) {
                return;
            }
            if (!opened) {
                const mapped = mapChatReadError(error);
                if (mapped) throw mapped;
            }
            if (error instanceof HttpException) throw error;
            console.error("Error in chat messages", error);
            if (!opened) {
                throw new HttpException({ error: "An error occurred" }, 500);
            }
            try {
                await session.fail({ error: "An error occurred" });
            } catch (failError) {
                if (
                    failError instanceof ChatCancelledError ||
                    session.signal.aborted
                ) {
                    return;
                }
                throw failError;
            }
        } finally {
            session.dispose();
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
            const messages = await this.getBookConversation.execute({
                userId: user.id,
                resourceType,
                resourceId,
                conversationId,
            });

            return { messages };
        } catch (error) {
            const mapped = mapChatReadError(error);
            if (mapped) throw mapped;
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
