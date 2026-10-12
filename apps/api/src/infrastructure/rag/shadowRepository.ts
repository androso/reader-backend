import { and, eq, isNull, sql } from "drizzle-orm";
import type { RagShadowJob, ShadowRepository } from "@reader/application";
import type { RagShadowResult } from "@reader/domain";
import type { Database } from "../../database/database.module";
import { Books, Conversations, Messages } from "../../db/schema";
import type { MessageExecutionMetadata } from "../../types/ragTelemetry";

export const createDrizzleRagShadowRepository = (
    database: Database
): ShadowRepository => ({
    async load(payload: RagShadowJob) {
        const [assistantRows, userRows, conversationRows, bookRows] =
            await Promise.all([
                database
                    .select({
                        id: Messages.id,
                        role: Messages.role,
                        conversationId: Messages.conversationId,
                        contextSources: Messages.contextSources,
                        executionMetadata: Messages.executionMetadata,
                    })
                    .from(Messages)
                    .where(eq(Messages.id, payload.assistantMessageId)),
                database
                    .select({
                        id: Messages.id,
                        role: Messages.role,
                        conversationId: Messages.conversationId,
                        content: Messages.content,
                    })
                    .from(Messages)
                    .where(eq(Messages.id, payload.userMessageId)),
                database
                    .select({
                        id: Conversations.id,
                        userId: Conversations.userId,
                        resourceType: Conversations.resourceType,
                        resourceId: Conversations.resourceId,
                    })
                    .from(Conversations)
                    .where(eq(Conversations.id, payload.conversationId)),
                database
                    .select({ id: Books.id, userId: Books.userId })
                    .from(Books)
                    .where(eq(Books.id, payload.bookId)),
            ]);

        return {
            assistant: assistantRows[0]
                ? {
                      ...assistantRows[0],
                      executionMetadata: assistantRows[0]
                          .executionMetadata as Record<string, unknown> | null,
                  }
                : null,
            userMessage: userRows[0] ?? null,
            conversation: conversationRows[0] ?? null,
            book: bookRows[0] ?? null,
        };
    },

    async persist(assistantMessageId: string, shadow: RagShadowResult) {
        const [updated] = await database
            .update(Messages)
            .set({
                executionMetadata: sql<MessageExecutionMetadata>`jsonb_set(${Messages.executionMetadata}, '{shadow}', ${JSON.stringify(shadow)}::jsonb, true)`,
            })
            .where(
                and(
                    eq(Messages.id, assistantMessageId),
                    isNull(sql`${Messages.executionMetadata}->'shadow'`)
                )
            )
            .returning({ id: Messages.id });
        return Boolean(updated);
    },
});
