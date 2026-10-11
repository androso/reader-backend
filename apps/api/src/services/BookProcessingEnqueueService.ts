import { EnqueueBookProcessing } from "@reader/application";
import type { BookProcessingRequest } from "@reader/domain";
import { createLogger } from "@reader/providers";
import { db } from "../db";
import { createDrizzleBookRepository } from "../infrastructure/books";
import { enqueueUploadedBookForProcessing } from "./BookProcessingQueue";

const log = createLogger("BookProcessingEnqueueService");

export interface BookProcessingEnqueueRepository {
    markQueueFailed(
        bookId: string,
        userId: string,
        error: string
    ): Promise<boolean>;
}

export interface BookProcessingEnqueueDependencies {
    enqueue(payload: BookProcessingRequest): Promise<void>;
    repository: BookProcessingEnqueueRepository;
}

export { BookProcessingQueueUnavailableError } from "@reader/domain";
export type { BookProcessingRequest as BookProcessingJobData };

export const createBookProcessingEnqueueRepository = (
    database = db
): BookProcessingEnqueueRepository => createDrizzleBookRepository(database);

const defaultDependencies: BookProcessingEnqueueDependencies = {
    enqueue: enqueueUploadedBookForProcessing,
    repository: createBookProcessingEnqueueRepository(),
};

export const handleBookProcessingEnqueue = async (
    payload: BookProcessingRequest,
    dependencies: BookProcessingEnqueueDependencies = defaultDependencies
) =>
    new EnqueueBookProcessing({
        queue: { enqueue: dependencies.enqueue },
        repository: dependencies.repository,
        logger: log,
    }).execute(payload);
