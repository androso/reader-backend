import { ScrollArea } from "@radix-ui/react-scroll-area";
import { BookOpenText, ChevronDown, Sparkles } from "lucide-react";
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";

export type ContextSource = {
    id: string;
    chunkIndex: number;
    score: number;
    bestRank: number;
    excerpt: string;
};

export type Message = {
    id?: string | null;
    role: string;
    content: string;
    contextSources?: ContextSource[] | null;
    completionStatus?: "complete" | "truncated" | "cancelled" | "failed" | null;
};

const formatScore = (score: number) =>
    Number.isFinite(score) ? score.toFixed(4) : "n/a";

const MessageSources = ({ sources }: { sources: ContextSource[] }) => (
    <details className="group max-w-[85%] rounded-lg border border-white/10 bg-[#2f3039] text-[#d6d5e3] shadow-sm">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-white/85 marker:hidden [&::-webkit-details-marker]:hidden">
            <BookOpenText className="h-4 w-4 text-[#c6c5d4]" />
            <span>Sources</span>
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] leading-4 text-white/70">
                {sources.length}
            </span>
            <ChevronDown className="ml-auto h-4 w-4 text-white/60 transition-transform group-open:rotate-180" />
        </summary>
        <div className="max-h-80 space-y-3 overflow-y-auto border-t border-white/10 px-3 py-3">
            {sources.map((source, index) => (
                <div
                    key={`${source.id}-${index}`}
                    className="border-b border-white/10 pb-3 last:border-b-0 last:pb-0"
                >
                    <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold uppercase tracking-normal text-white/60">
                        <span>Chunk {source.chunkIndex}</span>
                        <span>Score {formatScore(source.score)}</span>
                        <span>Rank {source.bestRank}</span>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-[#c6c5d4]">
                        {source.excerpt}
                    </p>
                </div>
            ))}
        </div>
    </details>
);

const AssistantMessageContent = ({ content }: { content: string }) => (
    <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
            a: ({ children, ...props }) => (
                <a {...props} target="_blank" rel="noreferrer">
                    {children}
                </a>
            ),
        }}
    >
        {content}
    </ReactMarkdown>
);

const MessageList = memo(
    ({
        messages,
        isMobile,
        isExpanded,
    }: {
        messages: Message[];
        isMobile: boolean;
        isExpanded: boolean;
    }) => {
        return (
            <ScrollArea
                className={`${isMobile ? (isExpanded ? "h-full" : "h-[200px]") : "h-full"} space-y-3 overflow-y-scroll p-6 md:p-8`}
            >
                {(isMobile && !isExpanded ? messages.slice(-2) : messages)
                    .filter(Boolean)
                    .map((message: Message, index: number) => {
                        const isAssistant = message.role === "assistant";
                        const sources = message.contextSources ?? [];

                        return (
                            <div
                                key={index}
                                className={`mb-4 flex flex-col gap-2 ${
                                    isAssistant ? "items-start" : "items-end"
                                }`}
                            >
                                <div className="flex items-center gap-3">
                                    {isAssistant && (
                                        <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-[#1f202b] text-white">
                                            <Sparkles className="h-4 w-4" />
                                        </div>
                                    )}
                                    <span className="font-sans text-xs font-medium leading-4 text-[#9e9dac]/70">
                                        {isAssistant ? "Mentarie" : "You"}
                                    </span>
                                    {!isAssistant && (
                                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#5d5f5f] text-xs font-bold text-white">
                                            U
                                        </div>
                                    )}
                                </div>
                                <div
                                    className={`max-w-[85%] rounded-2xl p-4 shadow-sm ${
                                        isAssistant
                                            ? "rounded-tl-none border border-white/5 bg-[#3e3f4b] text-[#c6c5d4]"
                                            : "rounded-tr-none bg-[#444654] text-white"
                                    }`}
                                >
                                    {isAssistant ? (
                                        <div className="chat-markdown font-sans text-sm font-semibold leading-relaxed">
                                            <AssistantMessageContent
                                                content={message.content}
                                            />
                                        </div>
                                    ) : (
                                        <p className="whitespace-pre-wrap font-sans text-sm font-semibold leading-relaxed">
                                            {message.content}
                                        </p>
                                    )}
                                </div>
                                {isAssistant && sources.length > 0 && (
                                    <MessageSources sources={sources} />
                                )}
                                {isAssistant &&
                                    message.completionStatus ===
                                        "truncated" && (
                                        <p className="max-w-[85%] text-xs text-amber-300">
                                            This response reached the model
                                            output limit and may be incomplete.
                                        </p>
                                    )}
                            </div>
                        );
                    })}
            </ScrollArea>
        );
    }
);
MessageList.displayName = "MessageList";
export default MessageList;
