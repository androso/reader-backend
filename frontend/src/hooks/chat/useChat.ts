import { Conversation } from "../../components/reader/ChatHistory";
import { useCallback, useEffect, useState } from "react";
import useSelectedConversation from "./useSelectedConversation";
import { Message } from "../../components/reader/MessageList";

export interface ChatState {
    messages: Message[];
    isHistoryOpen: boolean;
    isExpanded: boolean;
    isChatOpen: boolean;
    currentConversation: Conversation | null;
}
export const initialChatState: ChatState = {
    messages: [],
    isHistoryOpen: false,
    isExpanded: false,
    isChatOpen: false,
    currentConversation: null,
};

export const useChat = (bookId: string) => {
    const [chatState, setChatState] = useState<ChatState>(initialChatState);
    const [input, setInput] = useState("");
    const { data: selectedConversationData } = useSelectedConversation(
        chatState,
        bookId
    );

    const resetChat = useCallback(() => {
        setChatState(initialChatState);
        setInput("");
    }, []);

    const handleSelectConversation = useCallback(
        (conversation: Conversation) => {
            setChatState((prev) => ({
                ...prev,
                currentConversation: conversation,
                isHistoryOpen: false,
                isChatOpen: true,
            }));
        },
        []
    );

    const toggleHistory = useCallback(
        (refetchConversations: () => Promise<void>) => {
            refetchConversations();
            setChatState((prev) => ({
                ...prev,
                isHistoryOpen: !prev.isHistoryOpen,
                isChatOpen: true,
                isExpanded: true,
            }));
        },
        []
    );

    const handleMessageStream = useCallback(
        async (
            reader: ReadableStreamDefaultReader<Uint8Array>,
            setChatState: React.Dispatch<React.SetStateAction<ChatState>>
        ) => {
            const textDecoder = new TextDecoder();
            let buffer = "";
            let conversationId: string | null = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += textDecoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (!trimmedLine || !trimmedLine.startsWith("data: "))
                        continue;

                    const data = trimmedLine.slice(6).trim();
                    if (data === "[DONE]") continue;

                    try {
                        const jsonData = JSON.parse(data);
                        if (jsonData.type === "conversation_id") {
                            conversationId = jsonData.conversationId;
                            continue;
                        }

                        if (jsonData.content !== undefined) {
                            setChatState((prev) => {
                                const messages = [...prev.messages];
                                const lastMessage =
                                    messages[messages.length - 1];

                                if (lastMessage?.role === "assistant") {
                                    messages[messages.length - 1] = {
                                        ...lastMessage,
                                        content:
                                            lastMessage.content +
                                            jsonData.content,
                                    };
                                }

                                return {
                                    ...prev,
                                    messages,
                                    currentConversation:
                                        prev.currentConversation
                                            ? {
                                                  ...prev.currentConversation,
                                                  messages,
                                              }
                                            : null,
                                };
                            });
                        }
                    } catch (e) {
                        console.error("Failed to parse SSE data:", e);
                    }
                }
            }
            return conversationId;
        },
        []
    );

    const handleSubmit = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();
            if (!input.trim()) return;

            const userMessage = { id: null, role: "user", content: input };
            setInput("");

            try {
                const token = localStorage.getItem("token");
                const endpoint = chatState.currentConversation
                    ? `${import.meta.env.VITE_API_URL}/api/book/${bookId}/conversations/${chatState.currentConversation.id}/messages`
                    : `${import.meta.env.VITE_API_URL}/api/book/${bookId}/conversations`;

                setChatState((prev) => ({
                    ...prev,
                    messages: [...prev.messages, userMessage],
                    isChatOpen: true,
                }));

                const response = await fetch(endpoint, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({
                        message: userMessage.content,
                        role: "user",
                        messages: [...chatState.messages, userMessage],
                    }),
                });

                if (!response.ok) throw new Error("Failed to send message");

                const reader = response.body?.getReader();
                if (!reader) throw new Error("No response stream");

                setChatState((prev) => ({
                    ...prev,
                    messages: [
                        ...prev.messages,
                        { role: "assistant", content: "" },
                    ],
                }));

                const conversationId = await handleMessageStream(
                    reader,
                    setChatState
                );

                if (conversationId) {
                    setChatState((prev) => ({
                        ...prev,
                        currentConversation: {
                            id: conversationId,
                            title: "New conversation",
                            createdAt: new Date().toISOString().split("T")[0],
                            messages: prev.messages,
                        },
                    }));
                }
            } catch (error) {
                console.error("Error:", error);
                setChatState((prev) => ({
                    ...prev,
                    messages: [
                        ...prev.messages,
                        {
                            role: "assistant",
                            content:
                                "Sorry, there was an error processing your request.",
                        },
                    ],
                }));
            }
        },
        [input, chatState, bookId, handleMessageStream]
    );

    // Update messages when selected conversation changes
    useEffect(() => {
        if (selectedConversationData) {
            setChatState((prev) => ({
                ...prev,
                messages: selectedConversationData.messages,
            }));
        }
    }, [selectedConversationData]);

    const toggleExpanded = useCallback(() => {
        setChatState((prev) => ({
            ...prev,
            isExpanded: !prev.isExpanded,
        }));
    }, []);
    return {
        chatState,
        input,
        setInput,
        handleSubmit,
        handleSelectConversation,
        toggleHistory,
        toggleExpanded,
        resetChat,
        setChatState,
    };
};
