import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

const useConversations = (bookId: string) => {
    const fetchConversations = useCallback(async () => {
        const token = localStorage.getItem("token");
        const response = await fetch(
            `${import.meta.env.VITE_API_URL}/api/book/${bookId}/conversations`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            }
        );
        if (!response.ok) {
            throw new Error("Failed to fetch conversations");
        }
        return response.json();
    }, [bookId]);

    return useQuery({
        queryKey: [
            `${import.meta.env.VITE_API_URL}/api/book/${bookId}/conversations`,
        ],
        queryFn: fetchConversations,
        enabled: !!bookId,
    });
};

export default useConversations;
