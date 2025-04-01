// import { ChatState } from "../../components/reader/ChatInterface";
import { useQuery } from "@tanstack/react-query";
import { ChatState } from "./useChat";

const useSelectedConversation = (chatState: ChatState, bookId: string) => {
    return useQuery({
        queryKey: [
            chatState.currentConversation?.id,
            chatState.currentConversation?.createdAt,
            chatState.currentConversation?.lastMessageAt,
        ],
        queryFn: async () => {
            if (!chatState.currentConversation?.id) return null;
            const token = localStorage.getItem("token");
            const response = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/book/${bookId}/conversations/${chatState.currentConversation.id}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                }
            );
            if (!response.ok) {
                throw new Error("Failed to fetch conversation");
            }
            return response.json();
        },
        enabled: !!chatState.currentConversation,
    });
};

export default useSelectedConversation;
