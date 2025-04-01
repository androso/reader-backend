import { ScrollArea } from "@radix-ui/react-scroll-area";
import { memo } from "react";

export type Message = {
    role: string;
    content: string;
};

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
                className={`${isMobile ? (isExpanded ? "h-full" : "h-[200px]") : "h-full"} p-4 space-y-3 overflow-y-scroll`}
            >
                {(isMobile && !isExpanded ? messages.slice(-2) : messages)
                    .filter(Boolean)
                    .map((message: Message, index: number) => (
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
        );
    }
);
MessageList.displayName = "MessageList";
export default MessageList;
