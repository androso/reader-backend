import { eq } from "drizzle-orm";
import type { ChatMessageRepository } from "@reader/application";
import type { ChatMessage } from "@reader/domain";
import type { Database } from "../../database/database.module";
import { Messages } from "../../db/schema";
import { PUBLIC_MESSAGE_SELECTION } from "../../services/ChatExecutionMetadata";

export type DrizzleChatMessageRepository = Pick<
    ChatMessageRepository,
    "listForConversation"
>;

export const createDrizzleChatMessageRepository = (
    database: Database
): DrizzleChatMessageRepository => ({
    async listForConversation(conversationId) {
        const messages = await database
            .select(PUBLIC_MESSAGE_SELECTION)
            .from(Messages)
            .where(eq(Messages.conversationId, conversationId))
            .orderBy(Messages.createdAt);

        return messages as unknown as ChatMessage[];
    },
});
