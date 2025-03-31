import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AuthProtection } from "../components/AuthProtection";
import { useState } from "react";
import toast from "react-hot-toast";
import { FileUpload } from "../components/FileUpload";
import { signOut } from "../lib/auth";
import { Card } from "../components/ui/card";
import { Icon } from "@iconify/react";
import { useLocation } from "wouter";
import { ScrollArea } from "../components/ui/scroll-area";

function Home() {
    const [_, setLocation] = useLocation();
    const [hoveredBookId, setHoveredBookId] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const { data: booksData } = useQuery({
        queryKey: [`${import.meta.env.VITE_API_URL}/api/books`],
        queryFn: async () => {
            const token = localStorage.getItem("token");
            const response = await fetch(
                `${import.meta.env.VITE_API_URL}/api/books`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                }
            );
            if (!response.ok) {
                throw new Error("Network response was not ok");
            }
            return response.json();
        },
        enabled: true,
    });

    const queryClient = useQueryClient();

    const { mutate: uploadFile } = useMutation({
        mutationFn: async (file: File) => {
            const formData = new FormData();
            formData.append("file", file);
            const token = localStorage.getItem("token");
            const response = await fetch(
                `${import.meta.env.VITE_API_URL}/api/books`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                    method: "POST",
                    body: formData,
                }
            );
            if (!response.ok) {
                throw new Error("Failed to upload file");
            }
            return response.json();
        },
        onSuccess: (data) => {
            queryClient.invalidateQueries({
                queryKey: [`${import.meta.env.VITE_API_URL}/api/books`],
            });
            toast.success("File uploaded successfully");
        },
        onError: () => {
            toast.error("Failed to upload file");
        },
    });

    const handleFileUpload = (file: File) => {
        setIsUploading(true);
        uploadFile(file, {
            onSettled: () => setIsUploading(false),
        });
    };
    // should be invalidating query on success
    const { mutate: deleteItem } = useMutation({
        mutationFn: async (itemId: string) => {
            // const response = await deleteBook(itemId);
            const token = localStorage.getItem("token");
            const response = await fetch(
                `${import.meta.env.VITE_API_URL}/api/books/${itemId}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                    method: "DELETE",
                }
            );
            if (!response.ok) {
                throw new Error("Failed deleting file");
            }

            return response;
        },
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: ["/api/books"] });
            toast.success(result.message);
        },
        onError: (err) => {
            toast.error(err.message);
        },
    });

    return (
        <div className="container mx-auto p-8">
            <div className="flex justify-between items-center mb-8">
                <h1 className="text-3xl font-semibold">Library</h1>
                <div className="flex items-center gap-4">
                    <FileUpload
                        onUpload={handleFileUpload}
                        isLoading={isUploading}
                    />
                    <button
                        className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700"
                        onClick={() => {
                            signOut();
                            setLocation("/login");
                        }}
                    >
                        Logout
                    </button>
                </div>
            </div>

            <ScrollArea className="h-[calc(100vh-12rem)]">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {booksData?.books?.map((book) => (
                        <Card
                            key={book.id}
                            className="relative transition-colors hover:bg-slate-200 p-5 cursor-pointer"
                            onClick={() => setLocation(`/read/${book.fileKey}`)}
                            onMouseEnter={() => setHoveredBookId(book.id)}
                            onMouseLeave={() => setHoveredBookId(null)}
                        >
                            <h3 className="font-medium">{book.title}</h3>
                            <div
                                className={`transition-opacity absolute right-4 top-1/2 transform -translate-y-1/2 bg-slate-900 py-2 px-2 rounded-full text-white hover:text-red-400 ${
                                    hoveredBookId === book.id
                                        ? "opacity-100"
                                        : "opacity-0"
                                }`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    deleteItem(book.id);
                                }}
                            >
                                <Icon
                                    icon="solar:archive-bold"
                                    width="16"
                                    height="16"
                                />
                            </div>
                        </Card>
                    ))}
                </div>
            </ScrollArea>
        </div>
    );
}

export default function Page() {
    return (
        <AuthProtection>
            <Home />
        </AuthProtection>
    );
}
