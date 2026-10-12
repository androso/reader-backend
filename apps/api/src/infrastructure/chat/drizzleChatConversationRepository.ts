import { and, desc, eq } from "drizzle-orm";
import type { ChatConversationRepository } from "@reader/application";
import type { ChatConversation } from "@reader/domain";
import type { Database } from "../../database/database.module";
import { Conversations } from "../../db/schema";

export type DrizzleChatConversationRepository = Pick<
    ChatConversationRepository,
    "create" | "findScoped" | "listScoped" | "touch"
>;

export const createDrizzleChatConversationRepository = (
    database: Database
): DrizzleChatConversationRepository => ({
    async create({ userId, title, resourceType, resourceId }) {
        const [conversation] = await database
            .insert(Conversations)
            .values({ userId, title, resourceType, resourceId })
            .returning({ id: Conversations.id });
        return conversation;
    },

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

    async touch(conversationId, at) {
        await database
            .update(Conversations)
            .set({ lastMessageAt: at })
            .where(eq(Conversations.id, conversationId));
    },
});
