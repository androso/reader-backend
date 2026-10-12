import { ChatCancelledError } from "@reader/domain";

export const throwIfChatCancelled = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw new ChatCancelledError();
};
