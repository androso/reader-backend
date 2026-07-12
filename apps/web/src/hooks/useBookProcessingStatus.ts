import { useQuery } from "@tanstack/react-query";

export type BookProcessingStatus = {
    bookId: string;
    fileType: "epub" | "pdf" | null;
    ready: boolean;
    status: "processing" | "ready" | "failed";
    error?: string | null;
};

export const useBookProcessingStatus = (bookId: string) => {
    return useQuery({
        queryKey: ["book-processing-status", bookId],
        queryFn: async (): Promise<BookProcessingStatus> => {
            const response = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/books/${bookId}/status`,
                {
                    credentials: "include",
                }
            );

            if (!response.ok) {
                throw new Error("Failed to fetch book processing status");
            }

            return response.json();
        },
        enabled: !!bookId,
        refetchInterval: (query) => {
            const status = query.state.data?.status;
            return status === "ready" || status === "failed" ? false : 3000;
        },
    });
};
