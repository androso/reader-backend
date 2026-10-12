import type { ChatConversation } from "@reader/domain";
import type { ChatConversationRepository, ChatResourceAccess } from "./ports";

export interface ListBookConversationsDependencies {
    resourceAccess: ChatResourceAccess;
    conversations: Pick<ChatConversationRepository, "listScoped">;
}

export class ListBookConversations {
    constructor(private readonly deps: ListBookConversationsDependencies) {}

    async execute({
        userId,
        resourceType,
        resourceId,
    }: {
        userId: string;
        resourceType: string;
        resourceId: string;
    }): Promise<ChatConversation[]> {
        const authorized = await this.deps.resourceAccess.authorize({
            userId,
            resourceType,
            resourceId,
        });

        return this.deps.conversations.listScoped({
            userId,
            resourceType: authorized.resourceType,
            resourceId,
        });
    }
}
