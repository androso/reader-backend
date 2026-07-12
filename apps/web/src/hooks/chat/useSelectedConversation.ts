import { type ChatState } from "@/hooks/chat/useChat";
import { useQuery } from "@tanstack/react-query";

const useSelectedConversation = (chatState: ChatState, bookId: string) => {
    return useQuery({
        queryKey: [
            "conversation",
            bookId,
            chatState.currentConversation?.id,
            chatState.currentConversation?.lastMessageAt,
        ],
        queryFn: async () => {
            if (!chatState.currentConversation?.id) return null;
            const response = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/book/${bookId}/conversations/${chatState.currentConversation.id}`,
                {
                    credentials: "include",
                }
            );
            if (!response.ok) {
                throw new Error("Failed to fetch conversation");
            }
            return response.json();
        },
        enabled: !!bookId && !!chatState.currentConversation?.id,
    });
};

export default useSelectedConversation;
