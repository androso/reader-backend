"use client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SendHorizontal, Maximize2, Clock } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { memo, useState } from "react";

// Past conversations data
const pastConversations = [
    {
        id: 1,
        title: "Understanding Chapter 1",
        date: "2024-01-10",
        messages: [
            {
                role: "user",
                content: "Can you explain the main theme of Chapter 1?",
            },
            {
                role: "assistant",
                content:
                    "The main theme revolves around the concept of vertical progress versus horizontal progress in technology.",
            },
        ],
    },
    {
        id: 2,
        title: "Character Analysis",
        date: "2024-01-09",
        messages: [
            {
                role: "user",
                content: "What are the key characteristics of the protagonist?",
            },
            {
                role: "assistant",
                content:
                    "The protagonist shows strong leadership qualities and innovative thinking throughout the story.",
            },
        ],
    },
    {
        id: 3,
        title: "Plot Discussion",
        date: "2024-01-08",
        messages: [
            {
                role: "user",
                content: "How does the plot develop in the middle chapters?",
            },
            {
                role: "assistant",
                content:
                    "The plot intensifies as new challenges emerge, testing the characters' resolve.",
            },
        ],
    },
];

const MessageList = memo(
    ({
        isMobile,
        messages,
        setOpen,
        isExpanded,
        onExpand,
    }: {
        isMobile: boolean;
        messages: any;
        setOpen?: (state: boolean) => void;
        isExpanded?: boolean;
        onExpand?: () => void;
    }) => (
        <>
            {isMobile && (
                <div className="flex justify-between p-2 border-b">
                    <button
                        onClick={onExpand}
                        className="text-gray-500 hover:text-gray-700"
                    >
                        <Maximize2 className="h-5 w-5" />
                    </button>
                    <button
                        onClick={() => setOpen?.(false)}
                        className="text-gray-500 hover:text-gray-700"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
            )}

            <ScrollArea
                className={`${isMobile ? (isExpanded ? "h-[60dvh]" : "h-[200px]") : "h-full"} p-4 space-y-3`}
            >
                {(isMobile && !isExpanded ? messages.slice(-2) : messages)
                    .filter(Boolean)
                    .map((message: any, index: number) => (
                        <div
                            key={index}
                            className={`mb-4 p-3 rounded-lg ${
                                message.role === "assistant"
                                    ? "bg-blue-50 border border-blue-100"
                                    : "bg-gray-50 border border-gray-100"
                            }`}
                        >
                            <p
                                className={`text-sm leading-relaxed ${
                                    message.role === "assistant"
                                        ? "text-blue-700 font-medium"
                                        : "text-gray-700"
                                }`}
                            >
                                {message.content}
                            </p>
                        </div>
                    ))}
            </ScrollArea>
        </>
    )
);

MessageList.displayName = "MessageList";

export function ChatInterface({ isMobile = false }: { isMobile?: boolean }) {
    const [messages, setMessages] = useState<
        Array<{ role: string; content: string }>
    >([]);
    const [input, setInput] = useState("");
    const [isOpen, setIsOpen] = useState(false);

    const [isExpanded, setIsExpanded] = useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [selectedConversation, setSelectedConversation] = useState<
        number | null
    >(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim()) return;

        const userMessage = { role: "user", content: input };
        setMessages((prev) => [...prev, userMessage]);
        setInput("");
        setIsOpen(true);

        try {
            const response = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messages: [...messages, userMessage] }),
            });

            const data = await response.json();
            setMessages((prev) => [
                ...prev,
                { role: "assistant", content: data.text },
            ]);
        } catch (error) {
            console.error("Error:", error);
            setMessages((prev) => [
                ...prev,
                {
                    role: "assistant",
                    content:
                        "Sorry, there was an error processing your request.",
                },
            ]);
        }
    };

    return (
        <div className={`flex ${!isMobile && "h-full"} relative`}>
            {!isMobile && isSidebarOpen && (
                <div className="w-64 border-r border-gray-200 bg-gray-50">
                    <div className="p-4 border-b border-gray-200">
                        <h2 className="text-lg font-semibold">
                            Past Conversations
                        </h2>
                    </div>
                    <ScrollArea className="h-full">
                        {pastConversations.map((conversation) => (
                            <button
                                key={conversation.id}
                                onClick={() =>
                                    setSelectedConversation(conversation.id)
                                }
                                className={`w-full p-4 text-left hover:bg-gray-100 border-b border-gray-200 ${
                                    selectedConversation === conversation.id
                                        ? "bg-gray-100"
                                        : ""
                                }`}
                            >
                                <div className="flex items-center gap-2 mb-1">
                                    <Clock className="h-4 w-4 text-gray-500" />
                                    <span className="text-sm font-medium">
                                        {conversation.title}
                                    </span>
                                </div>
                                <span className="text-xs text-gray-500">
                                    {conversation.date}
                                </span>
                            </button>
                        ))}
                    </ScrollArea>
                </div>
            )}
            {!isMobile && (
                <button
                    onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                    className="absolute left-0 top-4 z-10 p-2 bg-white border rounded-r-md hover:bg-gray-50"
                    style={{
                        transform: isSidebarOpen
                            ? "translateX(16rem)"
                            : "translateX(0)",
                    }}
                >
                    {isSidebarOpen ? "←" : "→"}
                </button>
            )}
            <div
                className={`flex flex-col ${!isMobile && "flex-1"} rounded-md ${
                    isMobile &&
                    `absolute bottom-2 w-11/12 left-1/2 -translate-x-1/2 shadow-lg shadow-blue-500/50 border-2 border-slate-300 ${
                        isExpanded ? "h-[80dvh] ]" : ""
                    }`
                } shadow-lg bg-white `}
            >
                {isMobile && isOpen && (
                    <MessageList
                        messages={messages}
                        setOpen={setIsOpen}
                        isMobile={true}
                        isExpanded={isExpanded}
                        onExpand={() => setIsExpanded(!isExpanded)}
                    />
                )}
                {!isMobile && (
                    <MessageList messages={messages} isMobile={false} />
                )}
                <form
                    onSubmit={handleSubmit}
                    className="border-t border-gray-200 p-4"
                >
                    <div className="flex gap-2">
                        <Input
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder="Ask about this book..."
                            className="flex-1"
                        />
                        <Button type="submit" size="icon" variant="ghost">
                            <SendHorizontal className="h-5 w-5" />
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    );
}
