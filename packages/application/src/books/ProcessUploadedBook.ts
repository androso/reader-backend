import {
    BookDeletedDuringProcessingError,
    BookFileTypeMismatchError,
    BookNotFoundError,
    type BookIngestionResult,
    type BookProcessingRequest,
    type ProcessUploadedBookOptions,
} from "@reader/domain";
import { noopLogger } from "./ports";
import type {
    BookCollectionCleanup,
    BookIngestion,
    BookProcessingRepository,
    BookSearchCache,
    Logger,
} from "./ports";

export interface ProcessUploadedBookDependencies {
    repository: BookProcessingRepository;
    ingestion: BookIngestion;
    cleanup: BookCollectionCleanup;
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
        const start = Date.now();
        let result: BookIngestionResult;
        this.logger.info("Handling uploaded book processing", {
            bookId: request.bookId,
            userId: request.userId,
            fileKey: request.fileKey,
            fileType: request.fileType,
            markFailedOnError: options.markFailedOnError ?? true,
        });
        try {
            const book = await this.deps.repository.findBookForProcessing(
                request.bookId,
                request.userId
            );
            if (!book) throw new BookNotFoundError(request.bookId);
            if (book.fileType !== request.fileType) {
                throw new BookFileTypeMismatchError(
                    request.bookId,
                    request.fileType,
                    book.fileType
                );
            }

            this.logger.info("Processing book", {
                bookId: request.bookId,
                fileKey: request.fileKey,
            });
            result = await this.deps.ingestion.ingest({
                bookId: request.bookId,
                fileKey: request.fileKey,
                fileType: request.fileType,
            });

            const published = await this.deps.repository.markReady(
                request.bookId,
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
                await this.deps.cleanup.deleteCollection(result.collectionName);
                throw new BookDeletedDuringProcessingError(request.bookId);
            }
        } catch (error) {
            this.logger.error("Uploaded book processing failed", {
                bookId: request.bookId,
                fileKey: request.fileKey,
                durationMs: Date.now() - start,
                error: getErrorMessage(error),
            });
            if (options.markFailedOnError ?? true) {
                await this.deps.repository.markFailed(
                    request.bookId,
                    getErrorMessage(error)
                );
            } else {
                this.logger.warn("Skipping markFailed for book", {
                    bookId: request.bookId,
                });
            }
            throw error;
        }

        this.logger.info("Uploaded book processing succeeded", {
            bookId: request.bookId,
            collectionName: result.collectionName,
            chunkCount: result.chunks,
            reusedCollection: result.reusedCollection,
            durationMs: Date.now() - start,
        });
        this.logger.info("Clearing hybrid search cache after processing", {
            collectionName: result.collectionName,
        });
        this.deps.cache.clearCollection(result.collectionName);
        return result;
    }
}
