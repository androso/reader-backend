import {
    ChatConversationNotFoundError,
    type ChatMessage,
} from "@reader/domain";
import type {
    ChatConversationRepository,
    ChatMessageRepository,
    ChatResourceAccess,
} from "./ports";

export interface GetBookConversationDependencies {
    resourceAccess: ChatResourceAccess;
    conversations: Pick<ChatConversationRepository, "findScoped">;
    messages: Pick<ChatMessageRepository, "listForConversation">;
}

export class GetBookConversation {
    constructor(private readonly deps: GetBookConversationDependencies) {}

    async execute({
        userId,
        resourceType,
        resourceId,
        conversationId,
    }: {
        userId: string;
        resourceType: string;
        resourceId: string;
        conversationId: string;
    }): Promise<ChatMessage[]> {
        const authorized = await this.deps.resourceAccess.authorize({
            userId,
            resourceType,
            resourceId,
        });

        const conversation = await this.deps.conversations.findScoped({
            conversationId,
            userId,
            resourceType: authorized.resourceType,
            resourceId,
        });
        if (!conversation) throw new ChatConversationNotFoundError();

        return this.deps.messages.listForConversation(conversationId);
    }
}
