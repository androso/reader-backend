import type { BookQueueControl } from "@reader/application";
import { BookProcessingBusyError } from "@reader/domain";
import {
    enqueueUploadedBookForProcessing,
    getBookProcessingQueue,
} from "../../services/BookProcessingQueue";

export interface BullMqQueueLike {
    getJob(jobId: string): Promise<
        | {
              getState(): Promise<string>;
              retry(
                  state: "failed" | "completed",
                  options: {
                      resetAttemptsMade: boolean;
                      resetAttemptsStarted: boolean;
                  }
              ): Promise<void>;
              remove(): Promise<void>;
          }
        | undefined
    >;
}

export interface BullMqBookQueueControlDependencies {
    queue?: BullMqQueueLike;
    enqueue?: typeof enqueueUploadedBookForProcessing;
}

const jobIdForBook = (bookId: string) => `book-processing-${bookId}`;

const pendingStates = new Set([
    "waiting",
    "delayed",
    "prioritized",
    "active",
    "waiting-children",
]);

export const createBullMqBookQueueControl = (
    dependencies: BullMqBookQueueControlDependencies = {}
): BookQueueControl => ({
    async retryOrEnqueue(request) {
        const queue = dependencies.queue ?? getBookProcessingQueue();
        const enqueue =
            dependencies.enqueue ?? enqueueUploadedBookForProcessing;
        const job = await queue.getJob(jobIdForBook(request.bookId));
        if (!job) {
            await enqueue(request);
            return "enqueued";
        }

        const state = await job.getState();
        if (state === "unknown") {
            await enqueue(request);
            return "enqueued";
        }
        if (state === "failed" || state === "completed") {
            await job.retry(state, {
                resetAttemptsMade: true,
                resetAttemptsStarted: true,
            });
            return "retried";
        }
        if (pendingStates.has(state)) {
            throw new BookProcessingBusyError(request.bookId);
        }
        throw new BookProcessingBusyError(request.bookId);
    },

    async removePending(bookId) {
        const queue = dependencies.queue ?? getBookProcessingQueue();
        const job = await queue.getJob(jobIdForBook(bookId));
        if (!job) return;
        const state = await job.getState();
        if (
            state === "waiting" ||
            state === "delayed" ||
            state === "prioritized"
        ) {
            await job.remove();
        }
    },
});
