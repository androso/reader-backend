import { and, desc, eq } from "drizzle-orm";
import type { ChatConversationRepository } from "@reader/application";
import type { ChatConversation } from "@reader/domain";
import type { Database } from "../../database/database.module";
import { Conversations } from "../../db/schema";

export type DrizzleChatConversationRepository = Pick<
    ChatConversationRepository,
    "findScoped" | "listScoped"
>;

export const createDrizzleChatConversationRepository = (
    database: Database
): DrizzleChatConversationRepository => ({
    async findScoped({ conversationId, userId, resourceType, resourceId }) {
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

        return (
            (conversation as unknown as ChatConversation | undefined) ?? null
        );
    },

    async listScoped({ userId, resourceType, resourceId }) {
        const conversations = await database
            .select()
            .from(Conversations)
            .where(
                and(
                    eq(Conversations.userId, userId),
                    eq(Conversations.resourceType, resourceType),
                    eq(Conversations.resourceId, resourceId)
                )
            )
            .orderBy(desc(Conversations.lastMessageAt));

        return conversations as unknown as ChatConversation[];
    },
});
