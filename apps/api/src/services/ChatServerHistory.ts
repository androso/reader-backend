import type { ChatMessage } from "./OpenAIServices";

export {
    getSubmittedUserMessage,
    selectHistoryWindow as toChatHistory,
} from "@reader/domain";

export const buildUserMessageInsert = (
    conversationId: string,
    content: string
) => ({
    conversationId,
    role: "user" as const,
    content,
});

export const appendSubmittedUserMessage = (
    history: ChatMessage[],
    content: string
): ChatMessage[] => [...history, { role: "user", content }];
