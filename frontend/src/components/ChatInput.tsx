import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SendHorizontal } from "lucide-react";

export function ChatInput() {
    const [message, setMessage] = useState("");

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        // Stub - would normally send to API
        console.log("Sending message:", message);
        setMessage("");
    };

    return (
        <div className="fixed bottom-[env(safe-area-inset-bottom,0px)] left-0 right-0 p-4 bg-background/80 backdrop-blur-sm border-t border-border">
            <form
                onSubmit={handleSubmit}
                className="max-w-2xl mx-auto flex gap-3 items-center"
            >
                <Input
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Ask Claude about this book..."
                    className="flex-1 bg-background/50"
                />
                <Button type="submit" size="icon" variant="ghost">
                    <SendHorizontal className="h-5 w-5" />
                </Button>
            </form>
        </div>
    );
}
