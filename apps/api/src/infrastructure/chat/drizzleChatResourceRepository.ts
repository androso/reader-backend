import { eq } from "drizzle-orm";
import type { Database } from "../../database/database.module";
import { Books, Conversations } from "../../db/schema";

export const createDrizzleChatResourceRepository = (database: Database) => ({
    findBookById: async (resourceId: string) => {
        const [book] = await database
            .select({
                id: Books.id,
                userId: Books.userId,
            })
            .from(Books)
            .where(eq(Books.id, resourceId));
        return book ?? null;
    },
    createConversation: async ({
        userId,
        title,
        resourceType,
        resourceId,
    }: {
        userId: string;
        title: string;
        resourceType: "book";
        resourceId: string;
    }) => {
        const [conversation] = await database
            .insert(Conversations)
            .values({
                userId,
                title,
                resourceType,
                resourceId,
            })
            .returning({ id: Conversations.id });
        return conversation;
    },
});

export type DrizzleChatResourceRepository = ReturnType<
    typeof createDrizzleChatResourceRepository
>;
