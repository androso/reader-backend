import { asc, eq } from "drizzle-orm";
import type { ChatMessageRepository } from "@reader/application";
import type { ChatMessage } from "@reader/domain";
import type { ChatHistoryMessage } from "@reader/domain";
import { ChatCancelledError } from "@reader/domain";
import type { Database } from "../../database/database.module";
import { Messages } from "../../db/schema";
import { PUBLIC_MESSAGE_SELECTION } from "../../services/ChatExecutionMetadata";
import { recordObservationError } from "../../observability/langfuse";
import type { MessageExecutionMetadata } from "../../types/ragTelemetry";

export type DrizzleChatMessageRepository = Pick<
    ChatMessageRepository,
    "append" | "listForConversation" | "listHistoryForConversation"
>;

export const createDrizzleChatMessageRepository = (
    database: Database
): DrizzleChatMessageRepository => ({
    async append(message) {
        if (message.signal?.aborted) throw new ChatCancelledError();
        const span = message.trace?.startObservation(
            "save_assistant_message",
            message.role === "assistant"
                ? {
                      input: {
                          conversationId: message.conversationId,
                          responseLength: message.content.length,
                          sourceCount: message.contextSources?.length ?? 0,
                      },
                  }
                : undefined
        );
        try {
            const values =
                message.role === "user"
                    ? {
                          conversationId: message.conversationId,
                          role: message.role,
                          content: message.content,
                      }
                    : {
                          conversationId: message.conversationId,
                          role: message.role,
                          content: message.content,
                          contextSources: message.contextSources ?? null,
                          completionStatus: message.completionStatus ?? null,
                          finishReason: message.finishReason ?? null,
                          executionMetadata:
                              (message.executionMetadata as MessageExecutionMetadata | null) ??
                              null,
                      };
            const [saved] = await database
                .insert(Messages)
                .values(values)
                .returning({ id: Messages.id });
            span?.update({
                output: {
                    saved: true,
                    responseLength: message.content.length,
                    sourceCount: message.contextSources?.length ?? 0,
                },
            });
            return saved as unknown as ChatMessage;
        } catch (error) {
            if (span) {
                recordObservationError(
                    span as never,
                    error,
                    "Assistant message save failed"
                );
            }
            throw error;
        } finally {
            span?.end();
        }
    },

    async listForConversation(conversationId) {
        const messages = await database
            .select(PUBLIC_MESSAGE_SELECTION)
            .from(Messages)
            .where(eq(Messages.conversationId, conversationId))
            .orderBy(Messages.createdAt);

        return messages as unknown as ChatMessage[];
    },

    async listHistoryForConversation(conversationId) {
        const messages = await database
            .select({
                role: Messages.role,
                content: Messages.content,
            })
            .from(Messages)
            .where(eq(Messages.conversationId, conversationId))
            .orderBy(asc(Messages.createdAt));

        return messages as unknown as ChatHistoryMessage[];
    },
});
