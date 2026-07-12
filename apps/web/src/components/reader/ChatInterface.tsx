"use client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
    ArrowLeft,
    SendHorizontal,
    History,
    ChevronDown,
    Quote,
    X,
    PanelLeftOpen,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import MessageList, { Message } from "./MessageList";
import ChatHistory from "./ChatHistory";
import useConversations from "@/hooks/chat/useConversations";
import { useChat } from "@/hooks/chat/useChat";
import { useBookProcessingStatus } from "@/hooks/useBookProcessingStatus";
import type { HighlightContext } from "@/types/highlightContext";

const CHAT_MODELS = [
    { value: "gpt-4o-mini", label: "GPT-4o mini" },
    { value: "gpt-5.5-2026-04-23", label: "GPT-5.5" },
    { value: "gpt-5.4-mini-2026-03-17", label: "GPT-5.4 mini" },
];

interface ChatInterfaceProps {
    isMobile?: boolean;
    bookId: string;
    onBack?: () => void;
    highlightContext?: HighlightContext | null;
    onClearHighlightContext?: () => void;
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
        const baseClasses = `flex flex-col ${!isMobile && "h-full flex-1"} overflow-hidden`;
        const mobileClasses = isMobile
            ? `absolute bottom-4 w-[calc(100%-2rem)] left-1/2 -translate-x-1/2 rounded-2xl shadow-[0px_18px_50px_rgba(0,0,0,0.28)] ${
                  isExpanded ? "h-[80dvh] bg-[#343541]" : "bg-transparent"
              }`
            : "";
        return `${baseClasses} ${mobileClasses} ${!isMobile ? "bg-[#343541]" : ""}`;
    }, [isMobile, isExpanded]);

    return <div className={layoutClasses}>{children}</div>;
};

export function ChatInterface({
    isMobile = false,
    bookId,
    onBack,
    highlightContext = null,
    onClearHighlightContext,
}: ChatInterfaceProps) {
    const conversationsQuery = useConversations(bookId);
    const { data: conversationsData, refetch: refetchConversations } =
        conversationsQuery;
    const { data: processingStatus } = useBookProcessingStatus(bookId);
    const [selectedModel, setSelectedModel] = useState(CHAT_MODELS[0].value);
    const [isDesktopHistoryVisible, setIsDesktopHistoryVisible] =
        useState(true);
    const inputRef = useRef<HTMLInputElement>(null);
    const isDocumentReady = processingStatus?.ready ?? false;
    const processingError =
        processingStatus?.status === "failed"
            ? processingStatus.error ||
              "Document text processing failed. This PDF may be scanned or image-only, and OCR is not enabled yet."
            : null;
    const {
        chatState,
        handleSelectConversation,
        handleSubmit,
        input,
        setChatState,
        setInput,
        startNewConversation,
        isSending,
    } = useChat(bookId);
    const conversations = conversationsData?.conversations ?? [];

    useEffect(() => {
        if (isMobile || !highlightContext || !isDocumentReady) return;

        inputRef.current?.focus();
    }, [highlightContext, isDocumentReady, isMobile]);

    return (
        <div className={`relative flex ${!isMobile && "h-full w-full"}`}>
            {!isMobile && isDesktopHistoryVisible && (
                <div className="w-64 shrink-0 overflow-x-hidden">
                    <ChatHistory
                        conversations={conversations}
                        currentConversationId={
                            chatState.currentConversation?.id
                        }
                        isLoading={conversationsQuery.isLoading}
                        isError={conversationsQuery.isError}
                        onNewConversation={startNewConversation}
                        onHideHistory={() => setIsDesktopHistoryVisible(false)}
                        onSelectConversation={handleSelectConversation}
                    />
                </div>
            )}
            <ChatLayout isMobile={isMobile} isExpanded={chatState.isExpanded}>
                {!isMobile && onBack && (
                    <div className="flex shrink-0 items-center gap-1 px-6 pt-6 md:px-8 md:pt-8">
                        {!isDesktopHistoryVisible && (
                            <button
                                type="button"
                                onClick={() => {
                                    refetchConversations();
                                    setIsDesktopHistoryVisible(true);
                                }}
                                className="flex h-8 w-8 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                                aria-label="Show previous chats"
                                title="Show previous chats"
                            >
                                <PanelLeftOpen className="h-[18px] w-[18px]" />
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={onBack}
                            className="flex h-8 w-8 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                            aria-label="Back"
                            title="Back"
                        >
                            <ArrowLeft className="h-[18px] w-[18px]" />
                        </button>
                    </div>
                )}
                {isMobile &&
                    chatState.isChatOpen &&
                    chatState.isHistoryOpen && (
                        <div className="overflow-scroll h-full">
                            <ChatHistory
                                conversations={conversations}
                                currentConversationId={
                                    chatState.currentConversation?.id
                                }
                                isLoading={conversationsQuery.isLoading}
                                isError={conversationsQuery.isError}
                                onNewConversation={startNewConversation}
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
                    handleSubmit={(event) =>
                        handleSubmit(
                            event,
                            selectedModel,
                            highlightContext,
                            onClearHighlightContext
                        )
                    }
                    isDocumentReady={isDocumentReady}
                    isSending={isSending}
                    isCheckingStatus={!processingStatus}
                    processingError={processingError}
                    highlightContext={highlightContext}
                    onClearHighlightContext={onClearHighlightContext}
                    selectedModel={selectedModel}
                    setSelectedModel={setSelectedModel}
                    inputRef={inputRef}
                    onHistoryClick={() => {
                        if (isMobile) {
                            refetchConversations();
                            setChatState((prev) => ({
                                ...prev,
                                isHistoryOpen: !prev.isHistoryOpen,
                                isChatOpen: true,
                                isExpanded: true,
                            }));
                            return;
                        }

                        setIsDesktopHistoryVisible((isVisible) => {
                            if (!isVisible) {
                                refetchConversations();
                            }

                            return !isVisible;
                        });
                    }}
                    showHistoryButton={isMobile}
                    historyButtonLabel={
                        isMobile
                            ? "Toggle previous chats"
                            : isDesktopHistoryVisible
                              ? "Hide previous chats"
                              : "Show previous chats"
                    }
                    isHistoryButtonActive={
                        isMobile
                            ? chatState.isHistoryOpen
                            : isDesktopHistoryVisible
                    }
                />
            </ChatLayout>
        </div>
    );
}

const ChatMessages = ({
    messages,
    isMobile,
    isExpanded,
}: {
    messages: Message[];
    isMobile: boolean;
    isExpanded: boolean;
}) => (
    <div className="min-h-0 flex-1">
        <MessageList
            messages={messages}
            isMobile={isMobile}
            isExpanded={isExpanded}
        />
    </div>
);

const ChatInput = ({
    input,
    setInput,
    handleSubmit,
    isDocumentReady,
    isSending,
    isCheckingStatus,
    processingError,
    highlightContext,
    onClearHighlightContext,
    selectedModel,
    setSelectedModel,
    inputRef,
    onHistoryClick,
    showHistoryButton,
    historyButtonLabel,
    isHistoryButtonActive,
}: {
    input: string;
    setInput: (value: string) => void;
    handleSubmit: (e: React.FormEvent) => void;
    isDocumentReady: boolean;
    isSending: boolean;
    isCheckingStatus: boolean;
    processingError: string | null;
    highlightContext: HighlightContext | null;
    onClearHighlightContext?: () => void;
    selectedModel: string;
    setSelectedModel: (value: string) => void;
    inputRef: React.RefObject<HTMLInputElement | null>;
    onHistoryClick: () => void;
    showHistoryButton: boolean;
    historyButtonLabel: string;
    isHistoryButtonActive: boolean;
}) => (
    <form onSubmit={handleSubmit} className="mt-auto shrink-0 p-6 md:p-8">
        {!isDocumentReady && (
            <div
                className={`mb-2 rounded-md border px-3 py-2 text-sm ${
                    processingError
                        ? "border-red-200 bg-red-50 text-red-700"
                        : "border-amber-200 bg-amber-50 text-amber-800"
                }`}
            >
                {processingError ||
                    (isCheckingStatus
                        ? "Checking document processing status..."
                        : "Document context is still processing. You can ask questions once it is ready.")}
            </div>
        )}
        <div className="mb-2 flex justify-end">
            <div className="relative">
                <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    aria-label="Chat model"
                    className="h-9 appearance-none rounded-md border border-white/10 bg-[#2b2c32] pl-3 pr-8 text-sm font-semibold text-white shadow-sm outline-none transition-colors hover:bg-[#303139] focus:border-white/30 focus:ring-2 focus:ring-white/20"
                >
                    {CHAT_MODELS.map((model) => (
                        <option key={model.value} value={model.value}>
                            {model.label}
                        </option>
                    ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/70" />
            </div>
        </div>
        {highlightContext && (
            <div className="mb-2 rounded-lg border border-white/10 bg-[#2b2c32] px-3 py-2 text-white shadow-sm">
                <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-white/75">
                    <Quote className="h-3.5 w-3.5 text-[#c6c5d4]" />
                    <span>Selected text</span>
                    <button
                        type="button"
                        onClick={onClearHighlightContext}
                        className="ml-auto rounded-full p-1 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                        aria-label="Remove selected text"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
                <p className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-xs font-medium leading-relaxed text-[#d6d5e3]">
                    {highlightContext.text}
                </p>
            </div>
        )}
        <div className="flex items-center gap-2 rounded-full bg-white py-2 pl-2 pr-3 shadow-[0px_10px_30px_rgba(0,0,0,0.15)]">
            {showHistoryButton && (
                <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={onHistoryClick}
                    aria-label={historyButtonLabel}
                    title={historyButtonLabel}
                    className={`h-10 w-10 rounded-full text-[#616363] hover:bg-[#eeeeee] hover:text-[#1a1c1c] ${
                        isHistoryButtonActive
                            ? "bg-[#eeeeee] text-[#1a1c1c]"
                            : ""
                    }`}
                >
                    <History className="h-5 w-5" />
                </Button>
            )}
            <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                    isDocumentReady
                        ? "Ask about this document..."
                        : processingError
                          ? "Document text processing failed"
                          : "Document context is processing..."
                }
                className="h-11 flex-1 border-0 bg-transparent px-2 font-sans text-sm font-semibold text-[#1a1c1c] shadow-none ring-0 placeholder:text-[#9ea3a8] focus-visible:ring-0 focus-visible:ring-offset-0"
                disabled={!isDocumentReady || isSending}
            />
            <Button
                type="submit"
                size="icon"
                variant="default"
                disabled={!isDocumentReady || isSending}
                className="h-10 w-10 rounded-full bg-[#5c5d66] text-white hover:bg-[#4f5058] disabled:bg-[#c6c6c7]"
            >
                <SendHorizontal className="h-5 w-5" />
            </Button>
        </div>
    </form>
);
