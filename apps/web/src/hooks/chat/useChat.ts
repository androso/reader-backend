import { Conversation } from "@/components/reader/ChatHistory";
import { useCallback, useEffect, useState } from "react";
import useSelectedConversation from "./useSelectedConversation";
import { Message } from "@/components/reader/MessageList";
import type { HighlightContext } from "@/types/highlightContext";
import { useQueryClient } from "@tanstack/react-query";
import { conversationsQueryKey } from "./useConversations";

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
    const queryClient = useQueryClient();
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

    const startNewConversation = useCallback(() => {
        setChatState((prev) => ({
            ...prev,
            messages: [],
            currentConversation: null,
            isHistoryOpen: false,
            isChatOpen: true,
        }));
        setInput("");
    }, []);

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

                        if (jsonData.type === "sources") {
                            setChatState((prev) => {
                                const messages = [...prev.messages];
                                const lastMessage =
                                    messages[messages.length - 1];

                                if (lastMessage?.role === "assistant") {
                                    messages[messages.length - 1] = {
                                        ...lastMessage,
                                        contextSources: Array.isArray(
                                            jsonData.sources
                                        )
                                            ? jsonData.sources
                                            : [],
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
                            continue;
                        }

                        if (jsonData.error !== undefined) {
                            setChatState((prev) => {
                                const messages = [...prev.messages];
                                const lastMessage =
                                    messages[messages.length - 1];

                                if (lastMessage?.role === "assistant") {
                                    messages[messages.length - 1] = {
                                        ...lastMessage,
                                        content: jsonData.error,
                                    };
                                }

                                return {
                                    ...prev,
                                    messages,
                                };
                            });
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
        async (
            e: React.FormEvent,
            model: string,
            highlightContext: HighlightContext | null = null,
            onHighlightContextSent?: () => void
        ) => {
            e.preventDefault();
            if (!input.trim()) return;

            const userMessage = { id: null, role: "user", content: input };
            setInput("");

            try {
                const token = localStorage.getItem("token");
                const endpoint = chatState.currentConversation
                    ? `${process.env.NEXT_PUBLIC_API_URL}/api/book/${bookId}/conversations/${chatState.currentConversation.id}/messages`
                    : `${process.env.NEXT_PUBLIC_API_URL}/api/book/${bookId}/conversations`;

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
                        model,
                        ...(highlightContext ? { highlightContext } : {}),
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
                onHighlightContextSent?.();

                if (conversationId) {
                    setChatState((prev) => ({
                        ...prev,
                        currentConversation: {
                            id: conversationId,
                            title: userMessage.content.substring(0, 50) + "...",
                            createdAt: new Date().toISOString().split("T")[0],
                            messages: prev.messages,
                            lastMessageAt: new Date().toISOString(),
                        },
                    }));
                }

                await queryClient.invalidateQueries({
                    queryKey: conversationsQueryKey(bookId),
                });
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
        [input, chatState, bookId, handleMessageStream, queryClient]
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
        startNewConversation,
        setChatState,
    };
};
