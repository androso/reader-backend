import type { Messages } from "../db/schema";
import type { ChatMessage } from "./OpenAIServices";

export const getSubmittedUserMessage = (body: unknown): string | null => {
    if (!body || typeof body !== "object") return null;

    const { message } = body as { message?: unknown };
    if (typeof message !== "string") return null;

    const content = message.trim();
    return content.length > 0 ? content : null;
};

export const buildUserMessageInsert = (
    conversationId: string,
    content: string
) => ({
    conversationId,
    role: "user" as const,
    content,
});

export const toChatHistory = (
    messages: Pick<typeof Messages.$inferSelect, "role" | "content">[]
): ChatMessage[] =>
    messages.map((message) => ({
        role: message.role,
        content: message.content,
    }));

export const appendSubmittedUserMessage = (
    history: ChatMessage[],
    content: string
): ChatMessage[] => [...history, { role: "user", content }];
