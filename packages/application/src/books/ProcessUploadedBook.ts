import {
    BookDeletedDuringProcessingError,
    BookFileTypeMismatchError,
    BookLifecycleLockLostError,
    BookProcessingSkippedError,
    type BookIngestionResult,
    type BookProcessingRequest,
    type ProcessUploadedBookOptions,
} from "@reader/domain";
import { noopLogger } from "./ports";
import { throwIfLockLost } from "./throwIfLockLost";
import type {
    BookArtifactReferences,
    BookCollectionCleanup,
    BookIngestion,
    BookLifecycleLock,
    BookProcessingRepository,
    BookSearchCache,
    Logger,
} from "./ports";

export interface ProcessUploadedBookDependencies {
    repository: BookProcessingRepository;
    ingestion: BookIngestion;
    cleanup: BookCollectionCleanup;
    references: BookArtifactReferences;
    lock: BookLifecycleLock;
    cache: BookSearchCache;
    attemptIds: { next(): string };
    logger?: Logger;
}

const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : "Book processing failed";

export class ProcessUploadedBook {
    private readonly logger: Logger;

    constructor(private readonly deps: ProcessUploadedBookDependencies) {
        this.logger = deps.logger ?? noopLogger;
    }

    async execute(
        request: BookProcessingRequest,
        options: ProcessUploadedBookOptions = {}
    ): Promise<BookIngestionResult> {
        return this.deps.lock.withLock(request.bookId, async (signal) => {
            const start = Date.now();
            let fileKey = request.fileKey;
            let attemptCollectionName: string | undefined;
            let ingestionStarted = false;
            let published = false;
            this.logger.info("Handling uploaded book processing", {
                bookId: request.bookId,
                userId: request.userId,
                fileType: request.fileType,
                markFailedOnError: options.markFailedOnError ?? true,
            });

            try {
                const book = await this.deps.repository.findBookForProcessing(
                    request.bookId,
                    request.userId
                );
                if (!book) {
                    throw new BookProcessingSkippedError(
                        request.bookId,
                        "missing"
                    );
                }
                fileKey = book.fileKey;
                if (book.processingStatus === "ready") {
                    throw new BookProcessingSkippedError(
                        request.bookId,
                        "ready"
                    );
                }
                if (book.processingStatus === "deleting") {
                    throw new BookProcessingSkippedError(
                        request.bookId,
                        "deleting"
                    );
                }
                if (book.processingStatus !== "processing") {
                    throw new BookProcessingSkippedError(
                        request.bookId,
                        "not_processing"
                    );
                }
                if (book.fileType !== request.fileType) {
                    throw new BookFileTypeMismatchError(
                        request.bookId,
                        request.fileType,
                        book.fileType
                    );
                }

                this.logger.info("Processing book", {
                    bookId: request.bookId,
                    fileKey: book.fileKey,
                });
                const attemptCollection =
                    this.deps.cleanup.attemptCollectionName(
                        request.bookId,
                        this.deps.attemptIds.next()
                    );
                attemptCollectionName = attemptCollection;
                throwIfLockLost(signal);
                ingestionStarted = true;
                const result = await this.deps.ingestion.ingest({
                    bookId: request.bookId,
                    fileKey: book.fileKey,
                    fileType: book.fileType,
                    collectionName: attemptCollection,
                    signal,
                });

                throwIfLockLost(signal);
                const didPublish = await this.deps.repository.markReady(
                    request.bookId,
                    request.userId,
                    attemptCollection
                );
                if (!didPublish) {
                    this.logger.warn(
                        "Book disappeared before ingestion could publish",
                        {
                            bookId: request.bookId,
                            collectionName: attemptCollection,
                        }
                    );
                    throw new BookDeletedDuringProcessingError(request.bookId);
                }

                published = true;
                const previousCollectionName =
                    book.collectionName ??
                    this.deps.cleanup.defaultCollectionName(request.bookId);
                if (previousCollectionName !== attemptCollection) {
                    try {
                        const references =
                            await this.deps.references.countLiveCollectionReferences(
                                previousCollectionName,
                                request.bookId
                            );
                        if (references === 0) {
                            throwIfLockLost(signal);
                            await this.deps.cleanup.deleteCollection(
                                previousCollectionName
                            );
                        }
                    } catch (error) {
                        if (signal.aborted) throwIfLockLost(signal);
                        this.logger.error(
                            "Unable to clean up previous book collection",
                            {
                                bookId: request.bookId,
                                collectionName: previousCollectionName,
                                error: getErrorMessage(error),
                            }
                        );
                    }
                }

                this.logger.info("Uploaded book processing succeeded", {
                    bookId: request.bookId,
                    collectionName: attemptCollection,
                    chunkCount: result.chunks,
                    reusedCollection: result.reusedCollection,
                    durationMs: Date.now() - start,
                });
                this.logger.info(
                    "Clearing hybrid search cache after processing",
                    {
                        collectionName: attemptCollection,
                    }
                );
                for (const collectionName of new Set([
                    previousCollectionName,
                    attemptCollection,
                ])) {
                    try {
                        this.deps.cache.clearCollection(collectionName);
                    } catch (error) {
                        this.logger.error(
                            "Unable to clear hybrid search cache after processing",
                            {
                                bookId: request.bookId,
                                collectionName,
                                error: getErrorMessage(error),
                            }
                        );
                    }
                }
                return { ...result, collectionName: attemptCollection };
            } catch (error) {
                if (ingestionStarted && !published && attemptCollectionName) {
                    try {
                        await this.deps.cleanup.deleteCollection(
                            attemptCollectionName
                        );
                    } catch (cleanupError) {
                        this.logger.error(
                            "Unable to clean up failed book processing attempt",
                            {
                                bookId: request.bookId,
                                collectionName: attemptCollectionName,
                                error: getErrorMessage(cleanupError),
                            }
                        );
                    }
                }
                if (error instanceof BookLifecycleLockLostError) throw error;
                if (signal.aborted) throwIfLockLost(signal);
                if (error instanceof BookProcessingSkippedError) {
                    this.logger.info("Skipping book processing replay", {
                        bookId: request.bookId,
                        reason: error.reason,
                    });
                    throw error;
                }

                this.logger.error("Uploaded book processing failed", {
                    bookId: request.bookId,
                    fileKey,
                    durationMs: Date.now() - start,
                    error: getErrorMessage(error),
                });
                if (options.markFailedOnError ?? true) {
                    throwIfLockLost(signal);
                    await this.deps.repository.markFailed(
                        request.bookId,
                        request.userId,
                        getErrorMessage(error)
                    );
                } else {
                    this.logger.warn("Skipping markFailed for book", {
                        bookId: request.bookId,
                    });
                }
                throw error;
            }
        });
    }
}
