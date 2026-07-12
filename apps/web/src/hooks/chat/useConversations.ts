import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { type Conversation } from "@/components/reader/ChatHistory";

export const conversationsQueryKey = (bookId: string) => [
    "conversations",
    bookId,
];

export type ConversationsResponse = {
    conversations: Conversation[];
};

const useConversations = (bookId: string) => {
    const fetchConversations = useCallback(async () => {
        const response = await fetch(
            `${process.env.NEXT_PUBLIC_API_URL}/api/book/${bookId}/conversations`,
            {
                credentials: "include",
            }
        );
        if (!response.ok) {
            throw new Error("Failed to fetch conversations");
        }
        return response.json() as Promise<ConversationsResponse>;
    }, [bookId]);

    return useQuery({
        queryKey: conversationsQueryKey(bookId),
        queryFn: fetchConversations,
        enabled: !!bookId,
    });
};

export default useConversations;
