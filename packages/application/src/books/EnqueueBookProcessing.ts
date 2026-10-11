import {
    BookProcessingQueueUnavailableError,
    type BookProcessingRequest,
} from "@reader/domain";
import { noopLogger } from "./ports";
import type {
    BookProcessingQueue,
    BookQueueStateRepository,
    BookProcessingScheduler,
    Logger,
} from "./ports";

export interface EnqueueBookProcessingDependencies {
    queue: BookProcessingQueue;
    repository: BookQueueStateRepository;
    logger?: Logger;
}

export class EnqueueBookProcessing implements BookProcessingScheduler {
    private readonly logger: Logger;

    constructor(private readonly deps: EnqueueBookProcessingDependencies) {
        this.logger = deps.logger ?? noopLogger;
    }

    execute = async (request: BookProcessingRequest): Promise<void> => {
        this.logger.info("Enqueuing book for processing", {
            bookId: request.bookId,
            userId: request.userId,
            fileKey: request.fileKey,
            fileType: request.fileType,
        });
        try {
            await this.deps.queue.enqueue(request);
            this.logger.info("Book enqueued successfully", {
                bookId: request.bookId,
            });
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Unknown error";
            this.logger.error("Failed to enqueue book", {
                bookId: request.bookId,
                error: message,
            });
            await this.deps.repository.markQueueFailed(
                request.bookId,
                request.userId,
                message
            );
            throw new BookProcessingQueueUnavailableError(message);
        }
    };

    schedule = this.execute;
}
