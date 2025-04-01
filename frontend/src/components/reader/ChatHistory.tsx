import { ScrollArea } from "@radix-ui/react-scroll-area";
import { Message } from "./MessageList";
import { Button } from "../ui/button";
import { MessageSquareText } from "lucide-react";

export type Conversation = {
    id: string;
    title: string;
    messages: Message[];
    createdAt: string;
    lastMessageAt?: string;
    resourceId?: string;
    resourceType?: string;
    userId?: string;
};

function ChatHistory({
    conversations,
    onSelectConversation,
}: {
    conversations: Conversation[];
    onSelectConversation: (conversation: Conversation) => void;
}) {
    const handleNewThread = () => {
        onSelectConversation({
            id: Date.now().toString(),
            title: "New Conversation",
            createdAt: new Date().toISOString().split("T")[0],
            messages: [],
        });
    };

    return (
        <div className="border-r border-gray-200 bg-gray-50">
            <div className="p-4 border-b border-gray-200">
                <div className="flex justify-between items-center">
                    <Button
                        onClick={handleNewThread}
                        size="sm"
                        variant="outline"
                    >
                        Start new thread
                    </Button>
                </div>
            </div>
            <ScrollArea className="h-full">
                {conversations.map((conversation) => (
                    <button
                        key={conversation.id}
                        onClick={() => onSelectConversation(conversation)}
                        className="w-full p-4 text-left hover:bg-gray-100 border-b border-gray-200"
                    >
                        <div className="flex items-center gap-2 mb-1">
                            <MessageSquareText className="h-4 w-4 text-gray-500" />
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
    );
}
export default ChatHistory;
