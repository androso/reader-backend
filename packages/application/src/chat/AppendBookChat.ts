import {
    ChatConversationNotFoundError,
    ChatValidationError,
    getSubmittedUserMessage,
    normalizeEpubHighlight,
    selectHistoryWindow,
    type ChatHighlight,
    type ChatHistoryMessage,
    type ChatPromptMessage,
} from "@reader/domain";
import type {
    ChatConversationRepository,
    ChatEventSink,
    ChatMessageRepository,
    ChatModelResolver,
    ChatResourceAccess,
    Clock,
} from "./ports";
import { RunBookChat, type RunBookChatInput } from "./RunBookChat";
import { throwIfChatCancelled } from "./throwIfChatCancelled";

export type AppendBookChatInput = {
    userId: string;
    resourceType: string;
    resourceId: string;
    conversationId: string;
    message: unknown;
    model: unknown;
    highlightContext: unknown;
};

export type PreparedAppendBookChat = AppendBookChatInput & {
    message: string;
    model: string;
    highlightContext: ChatHighlight | null;
};

export interface AppendBookChatDependencies {
    resourceAccess: ChatResourceAccess;
    conversations: Pick<ChatConversationRepository, "findScoped" | "touch">;
    messages: Pick<
        ChatMessageRepository,
        "append" | "listForConversation" | "listHistoryForConversation"
    >;
    modelResolver: ChatModelResolver;
    clock: Clock;
    runner: RunBookChat;
}

export class AppendBookChat {
    constructor(private readonly deps: AppendBookChatDependencies) {}

    async prepare(input: AppendBookChatInput): Promise<PreparedAppendBookChat> {
        if (
            !input.resourceType ||
            !input.resourceId ||
            !input.conversationId ||
            input.resourceType !== "book"
        ) {
            throw new ChatValidationError("invalid_request", "Invalid request");
        }
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
        const conversation = await this.deps.conversations.findScoped({
            conversationId: input.conversationId,
            userId: input.userId,
            resourceType: authorized.resourceType,
            resourceId: input.resourceId,
        });
        if (!conversation) throw new ChatConversationNotFoundError();
        return {
            ...input,
            message,
            model,
            highlightContext,
        };
    }

    async execute(
        input: AppendBookChatInput & {
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
            routeName: input.routeName ?? "append_message",
        });
    }

    async executePrepared(input: {
        prepared: PreparedAppendBookChat;
        sink: ChatEventSink;
        signal: AbortSignal;
        routeName?: string;
    }): Promise<void> {
        const { prepared } = input;
        const stored = this.deps.messages.listHistoryForConversation
            ? await this.deps.messages.listHistoryForConversation(
                  prepared.conversationId
              )
            : (
                  await this.deps.messages.listForConversation(
                      prepared.conversationId
                  )
              ).map(
                  (message): ChatHistoryMessage => ({
                      role: message.role,
                      content: message.content,
                  })
              );
        const history = selectHistoryWindow(stored);
        const messages = [
            ...history,
            { role: "user" as const, content: prepared.message },
        ];
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
            messages,
            model: prepared.model,
            highlightContext: prepared.highlightContext,
            routeName: input.routeName ?? "append_message",
            sink: input.sink,
            signal: input.signal,
        };
        return this.deps.runner.execute(runInput);
    }
}
