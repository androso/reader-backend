import type { Messages } from "../db/schema";
import type { ChatMessage } from "./OpenAIServices";

export const getSubmittedUserMessage = (body: unknown): string | null => {
    if (!body || typeof body !== "object") return null;

    const { message } = body as { message?: unknown };
    if (typeof message !== "string") return null;

    const content = message.trim();
    return content.length > 0 && content.length <= 8_000 ? content : null;
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
): ChatMessage[] => {
    const bounded: typeof messages = [];
    let characters = 0;
    for (const message of messages.slice(-30).reverse()) {
        if (characters + message.content.length > 60_000) break;
        bounded.push(message);
        characters += message.content.length;
    }
    return bounded.reverse().map((message) => ({
        role: message.role,
        content: message.content,
    }));
};

export const appendSubmittedUserMessage = (
    history: ChatMessage[],
    content: string
): ChatMessage[] => [...history, { role: "user", content }];
