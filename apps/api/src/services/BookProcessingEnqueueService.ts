import type { BookProcessingJobData } from "@reader/jobs";
import { eq } from "drizzle-orm";
import { createLogger } from "@reader/providers";
import { db } from "../db";
import { Books } from "../db/schema";
import { enqueueUploadedBookForProcessing } from "./BookProcessingQueue";

const log = createLogger("BookProcessingEnqueueService");

export interface BookProcessingEnqueueRepository {
    markQueueFailed(bookId: string, error: string): Promise<void>;
}

export interface BookProcessingEnqueueDependencies {
    enqueue(payload: BookProcessingJobData): Promise<void>;
    repository: BookProcessingEnqueueRepository;
}

export class BookProcessingQueueUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BookProcessingQueueUnavailableError";
    }
}

const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : "Unknown error";

export const createBookProcessingEnqueueRepository = (
    database = db
): BookProcessingEnqueueRepository => ({
    async markQueueFailed(bookId, error) {
        log.error("Marking book queue failed", { bookId, error });
        await database
            .update(Books)
            .set({
                processingStatus: "queue_failed",
                processingError: `Book processing queue unavailable: ${error}`,
            })
            .where(eq(Books.id, bookId));
        log.error("Book queue marked failed", { bookId, error });
    },
});

const bookProcessingEnqueueRepository = createBookProcessingEnqueueRepository();

export const handleBookProcessingEnqueue = async (
    payload: BookProcessingJobData,
    dependencies: BookProcessingEnqueueDependencies = {
        enqueue: enqueueUploadedBookForProcessing,
        repository: bookProcessingEnqueueRepository,
    }
) => {
    log.info("Enqueuing book for processing", {
        bookId: payload.bookId,
        userId: payload.userId,
        fileKey: payload.fileKey,
        fileType: payload.fileType,
    });
    try {
        await dependencies.enqueue(payload);
        log.info("Book enqueued successfully", { bookId: payload.bookId });
    } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Failed to enqueue book", {
            bookId: payload.bookId,
            error: errorMessage,
        });
        await dependencies.repository.markQueueFailed(
            payload.bookId,
            errorMessage
        );

        throw new BookProcessingQueueUnavailableError(errorMessage);
    }
};
