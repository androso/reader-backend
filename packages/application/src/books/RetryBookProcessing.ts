import {
    BookLifecycleLockTimeoutError,
    BookNotFoundError,
    BookNotRetryableError,
    BookProcessingBusyError,
    BookProcessingQueueUnavailableError,
    RETRYABLE_BOOK_STATUSES,
} from "@reader/domain";
import { noopLogger } from "./ports";
import type {
    BookLifecycleLock,
    BookProcessingQueue,
    BookQueueControl,
    BookQueueStateRepository,
    BookReadRepository,
    BookRetryStateRepository,
    Logger,
} from "./ports";
import type { RetryableBookStatus } from "./ports";

export interface RetryBookProcessingDependencies {
    reads: Pick<BookReadRepository, "findOwned">;
    retryState: BookRetryStateRepository;
    queueState: BookQueueStateRepository;
    queue: BookQueueControl;
    lock: BookLifecycleLock;
    logger?: Logger;
}

export interface RetryBookProcessingResult {
    bookId: string;
    status: "processing";
}

const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : "Unknown error";

export class RetryBookProcessing {
    private readonly logger: Logger;

    constructor(private readonly deps: RetryBookProcessingDependencies) {
        this.logger = deps.logger ?? noopLogger;
    }

    async execute({
        bookId,
        userId,
    }: {
        bookId: string;
        userId: string;
    }): Promise<RetryBookProcessingResult> {
        try {
            return await this.deps.lock.withLock(bookId, async () => {
                const previous = await this.deps.reads.findOwned(
                    bookId,
                    userId
                );
                if (!previous) throw new BookNotFoundError(bookId);
                if (
                    !RETRYABLE_BOOK_STATUSES.includes(
                        previous.processingStatus as RetryableBookStatus
                    ) ||
                    !previous.fileType
                ) {
                    throw new BookNotRetryableError(
                        bookId,
                        previous.processingStatus
                    );
                }

                const previousStatus =
                    previous.processingStatus as RetryableBookStatus;
                const claimed = await this.deps.retryState.claimRetry(
                    bookId,
                    userId,
                    previousStatus
                );
                if (!claimed) {
                    throw new BookNotRetryableError(
                        bookId,
                        previous.processingStatus
                    );
                }
                if (!claimed.fileType) {
                    throw new BookNotRetryableError(
                        bookId,
                        claimed.processingStatus
                    );
                }

                try {
                    await this.deps.queue.retryOrEnqueue({
                        bookId: claimed.id,
                        userId: claimed.userId,
                        fileKey: claimed.fileKey,
                        fileType: claimed.fileType,
                    });
                } catch (error) {
                    if (error instanceof BookProcessingBusyError) {
                        await this.deps.retryState.restoreRetryable(
                            bookId,
                            userId,
                            previousStatus,
                            previous.processingError
                        );
                        throw error;
                    }

                    const message = errorMessage(error);
                    this.logger.error("Failed to retry book processing", {
                        bookId,
                        error: message,
                    });
                    await this.deps.queueState.markQueueFailed(
                        bookId,
                        userId,
                        message
                    );
                    throw new BookProcessingQueueUnavailableError(message);
                }

                return { bookId, status: "processing" };
            });
        } catch (error) {
            if (error instanceof BookLifecycleLockTimeoutError) {
                throw new BookProcessingBusyError(bookId);
            }
            throw error;
        }
    }
}
