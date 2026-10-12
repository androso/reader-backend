import {
    ChatValidationError,
    getSubmittedUserMessage,
    normalizeEpubHighlight,
    type ChatHighlight,
} from "@reader/domain";
import type {
    AuthorizedChatResource,
    ChatConversationRepository,
    ChatEventSink,
    ChatMessageRepository,
    ChatModelResolver,
    ChatResourceAccess,
    Clock,
} from "./ports";
import { RunBookChat, type RunBookChatInput } from "./RunBookChat";
import { throwIfChatCancelled } from "./throwIfChatCancelled";

export type StartBookChatInput = {
    userId: string;
    resourceType: string;
    resourceId: string;
    message: unknown;
    model: unknown;
    highlightContext: unknown;
};

export type PreparedStartBookChat = {
    userId: string;
    resourceType: AuthorizedChatResource["resourceType"];
    resourceId: string;
    message: string;
    model: string;
    highlightContext: ChatHighlight | null;
    conversationId: string;
};

export interface StartBookChatDependencies {
    resourceAccess: ChatResourceAccess;
    conversations: Pick<ChatConversationRepository, "create" | "touch">;
    messages: Pick<ChatMessageRepository, "append">;
    modelResolver: ChatModelResolver;
    clock: Clock;
    runner: RunBookChat;
}

export class StartBookChat {
    constructor(private readonly deps: StartBookChatDependencies) {}

    async prepare(input: StartBookChatInput): Promise<PreparedStartBookChat> {
        const message = getSubmittedUserMessage({ message: input.message });
        if (!message) {
            throw new ChatValidationError(
                "message_required",
                "Message is required"
            );
        }
        const highlightContext = normalizeEpubHighlight(input.highlightContext);
        const model = this.deps.modelResolver.resolve(input.model);
        if (!model) {
            throw new ChatValidationError(
                "unsupported_chat_model",
                "Unsupported chat model"
            );
        }
        const authorized = await this.deps.resourceAccess.authorize({
            userId: input.userId,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
        });
        const conversation = await this.deps.conversations.create({
            userId: input.userId,
            title: message.substring(0, 50) + "...",
            resourceType: authorized.resourceType,
            resourceId: input.resourceId,
        });
        return {
            userId: input.userId,
            resourceType: authorized.resourceType,
            resourceId: input.resourceId,
            message,
            model,
            highlightContext,
            conversationId: conversation.id,
        };
    }

    async execute(
        input: StartBookChatInput & {
            sink: ChatEventSink;
            signal: AbortSignal;
            routeName?: string;
        }
    ): Promise<void> {
        const prepared = await this.prepare(input);
        return this.executePrepared({
            prepared,
            sink: input.sink,
            signal: input.signal,
            routeName: input.routeName ?? "create_conversation",
        });
    }

    async executePrepared(input: {
        prepared: PreparedStartBookChat;
        sink: ChatEventSink;
        signal: AbortSignal;
        routeName?: string;
    }): Promise<void> {
        const { prepared } = input;
        await input.sink.emit({
            type: "conversation_id",
            conversationId: prepared.conversationId,
        });
        throwIfChatCancelled(input.signal);
        const userMessage = await this.deps.messages.append({
            conversationId: prepared.conversationId,
            role: "user",
            content: prepared.message,
            signal: input.signal,
        });
        throwIfChatCancelled(input.signal);
        await this.deps.conversations.touch(
            prepared.conversationId,
            this.deps.clock.now()
        );
        const runInput: RunBookChatInput = {
            userId: prepared.userId,
            bookId: prepared.resourceId,
            conversationId: prepared.conversationId,
            userMessageId: userMessage.id,
            query: prepared.message,
            messages: [{ role: "user", content: prepared.message }],
            model: prepared.model,
            highlightContext: prepared.highlightContext,
            routeName: input.routeName ?? "create_conversation",
            sink: input.sink,
            signal: input.signal,
        };
        return this.deps.runner.execute(runInput);
    }
}
