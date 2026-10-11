import {
    BookDeletedDuringProcessingError,
    BookFileTypeMismatchError,
    BookProcessingSkippedError,
    type BookIngestionResult,
    type BookProcessingRequest,
    type ProcessUploadedBookOptions,
} from "@reader/domain";
import { noopLogger } from "./ports";
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
        return this.deps.lock.withLock(request.bookId, async () => {
            const start = Date.now();
            let fileKey = request.fileKey;
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
                const result = await this.deps.ingestion.ingest({
                    bookId: request.bookId,
                    fileKey: book.fileKey,
                    fileType: book.fileType,
                });

                const published = await this.deps.repository.markReady(
                    request.bookId,
                    request.userId,
                    result.collectionName
                );
                if (!published) {
                    this.logger.warn(
                        "Book disappeared before ingestion could publish",
                        {
                            bookId: request.bookId,
                            collectionName: result.collectionName,
                        }
                    );
                    const references =
                        await this.deps.references.countLiveCollectionReferences(
                            result.collectionName,
                            request.bookId
                        );
                    if (references === 0) {
                        await this.deps.cleanup.deleteCollection(
                            result.collectionName
                        );
                    }
                    throw new BookDeletedDuringProcessingError(request.bookId);
                }

                this.logger.info("Uploaded book processing succeeded", {
                    bookId: request.bookId,
                    collectionName: result.collectionName,
                    chunkCount: result.chunks,
                    reusedCollection: result.reusedCollection,
                    durationMs: Date.now() - start,
                });
                this.logger.info(
                    "Clearing hybrid search cache after processing",
                    {
                        collectionName: result.collectionName,
                    }
                );
                this.deps.cache.clearCollection(result.collectionName);
                return result;
            } catch (error) {
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
