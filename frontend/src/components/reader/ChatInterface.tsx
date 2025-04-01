"use client";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { SendHorizontal, Maximize2, History } from "lucide-react";
import { useMemo } from "react";
import { ChatState, initialChatState, useChat } from "../../hooks/chat/useChat";
import useConversations from "../../hooks/chat/useConversations";
import ChatHistory from "./ChatHistory";
import MessageList, { Message } from "./MessageList";

interface ChatInterfaceProps {
    isMobile?: boolean;
    bookId: string;
}

const ChatLayout = ({
    isMobile,
    isExpanded,
    children,
}: {
    isMobile: boolean;
    isExpanded: boolean;
    children: React.ReactNode;
}) => {
    const layoutClasses = useMemo(() => {
        const baseClasses = `flex flex-col ${!isMobile && "flex-1 justify-end"} rounded-md`;
        const mobileClasses = isMobile
            ? `absolute bottom-2 w-11/12 left-1/2 -translate-x-1/2 shadow-lg shadow-blue-500/50 border-2 border-slate-300 ${
                  isExpanded ? "h-[80dvh]" : ""
              }`
            : "";
        return `${baseClasses} ${mobileClasses} shadow-lg bg-white`;
    }, [isMobile, isExpanded]);

    return <div className={layoutClasses}>{children}</div>;
};

export function ChatInterface({
    isMobile = false,
    bookId,
}: ChatInterfaceProps) {
    const { data: conversationsData, refetch: refetchConversations } =
        useConversations(bookId);
    const {
        chatState,
        handleSelectConversation,
        handleSubmit,
        input,
        setChatState,
        setInput,
    } = useChat(bookId);

    return (
        <div className={`flex ${!isMobile && "h-full"} relative`}>
            {!isMobile && chatState.isHistoryOpen && (
                <div className="overflow-x-hidden max-w-[40%]">
                    <ChatHistory
                        conversations={conversationsData?.conversations}
                        onSelectConversation={handleSelectConversation}
                    />
                </div>
            )}
            <ChatLayout isMobile={isMobile} isExpanded={chatState.isExpanded}>
                {chatState.isChatOpen && (
                    <ChatHeader
                        chatState={chatState}
                        setChatState={setChatState}
                    />
                )}
                {isMobile &&
                    chatState.isChatOpen &&
                    chatState.isHistoryOpen && (
                        <div className="overflow-scroll h-full">
                            <ChatHistory
                                conversations={conversationsData.conversations}
                                onSelectConversation={handleSelectConversation}
                            />
                        </div>
                    )}
                {chatState.isChatOpen && !chatState.isHistoryOpen && (
                    <ChatMessages
                        messages={chatState.messages}
                        isMobile={isMobile}
                        isExpanded={chatState.isExpanded}
                    />
                )}
                <ChatInput
                    input={input}
                    setInput={setInput}
                    handleSubmit={handleSubmit}
                    onHistoryClick={() => {
                        refetchConversations();
                        setChatState((prev) => ({
                            ...prev,
                            isHistoryOpen: !prev.isHistoryOpen,
                            isChatOpen: true,
                            isExpanded: true,
                        }));
                    }}
                />
            </ChatLayout>
        </div>
    );
}

const ChatHeader = ({
    chatState,
    setChatState,
}: {
    chatState: ChatState;
    setChatState: React.Dispatch<React.SetStateAction<ChatState>>;
}) => (
    <div
        className={`flex ${chatState.isHistoryOpen ? "justify-end" : "justify-between"} p-2 border-b`}
    >
        {!chatState.isHistoryOpen && (
            <button
                onClick={() =>
                    setChatState((prev) => ({
                        ...prev,
                        isExpanded: !prev.isExpanded,
                    }))
                }
                className="text-gray-500 hover:text-gray-700"
            >
                <Maximize2 className="h-5 w-5" />
            </button>
        )}
        <button
            onClick={() => setChatState(initialChatState)}
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
);

const ChatMessages = ({
    messages,
    isMobile,
    isExpanded,
}: {
    messages: Message[];
    isMobile: boolean;
    isExpanded: boolean;
}) => (
    <>
        <MessageList
            messages={messages}
            isMobile={isMobile}
            isExpanded={isExpanded}
        />
    </>
);

const ChatInput = ({
    input,
    setInput,
    handleSubmit,
    onHistoryClick,
}: {
    input: string;
    setInput: (value: string) => void;
    handleSubmit: (e: React.FormEvent) => void;
    onHistoryClick: () => void;
}) => (
    <form onSubmit={handleSubmit} className="border-t border-gray-200 p-4">
        <div className="flex gap-2">
            <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={onHistoryClick}
            >
                <History className="h-5 w-5" />
            </Button>
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
);
