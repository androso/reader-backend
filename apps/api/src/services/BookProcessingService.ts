import { and, eq } from "drizzle-orm";
import {
    processBookForSearch,
    type BookFileType,
    type ProcessBookResult,
} from "@reader/processing";
import { createLogger, storageProvider, vectorStore } from "@reader/providers";
import { db } from "../db";
import { Books } from "../db/schema";
import { bookSearchChunkStore } from "./BookSearchChunkStore";
import { hybridBookSearchService } from "./HybridBookSearchService";

const log = createLogger("BookProcessingService");

export interface ProcessUploadedBookPayload {
    bookId: string;
    userId: string;
    fileKey: string;
    fileType: BookFileType;
}

export interface BookProcessingRecord {
    id: string;
    userId: string;
    fileKey: string;
    fileType: BookFileType | null;
    collectionName: string | null;
    processingStatus: string;
    processingError: string | null;
}

export interface BookProcessingRepository {
    findBookForProcessing(
        bookId: string,
        userId: string
    ): Promise<BookProcessingRecord | null>;
    markReady(bookId: string, collectionName: string): Promise<void>;
    markFailed(bookId: string, error: string): Promise<void>;
}

export type ProcessBookForSearch = typeof processBookForSearch;

export interface ProcessUploadedBookOptions {
    markFailedOnError?: boolean;
}

const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : "Book processing failed";

const bookProcessingRepository: BookProcessingRepository = {
    async findBookForProcessing(bookId, userId) {
        log.debug("Finding book for processing", { bookId, userId });
        const [book] = await db
            .select()
            .from(Books)
            .where(and(eq(Books.id, bookId), eq(Books.userId, userId)));
        if (!book) {
            log.warn("Book not found for processing", { bookId, userId });
        } else {
            log.debug("Book found for processing", {
                bookId,
                userId,
                fileKey: book.fileKey,
                fileType: book.fileType,
                processingStatus: book.processingStatus,
            });
        }
        return book ?? null;
    },

    async markReady(bookId, collectionName) {
        log.info("Marking book as ready", { bookId, collectionName });
        await db
            .update(Books)
            .set({
                collectionName,
                processingStatus: "ready",
                processingError: null,
            })
            .where(eq(Books.id, bookId));
        log.info("Book marked as ready", { bookId, collectionName });
    },

    async markFailed(bookId, error) {
        log.error("Marking book as failed", { bookId, error });
        await db
            .update(Books)
            .set({
                processingStatus: "failed",
                processingError: error,
            })
            .where(eq(Books.id, bookId));
        log.error("Book marked as failed", { bookId, error });
    },
};

export const handleProcessUploadedBook = async (
    payload: ProcessUploadedBookPayload,
    repository: BookProcessingRepository,
    processBook: ProcessBookForSearch,
    options: ProcessUploadedBookOptions = {}
): Promise<ProcessBookResult> => {
    const start = Date.now();
    log.info("Handling uploaded book processing", {
        bookId: payload.bookId,
        userId: payload.userId,
        fileKey: payload.fileKey,
        fileType: payload.fileType,
        markFailedOnError: options.markFailedOnError ?? true,
    });

    try {
        const book = await repository.findBookForProcessing(
            payload.bookId,
            payload.userId
        );
        if (!book) {
            throw new Error(`Book ${payload.bookId} was not found`);
        }
        if (book.fileType !== payload.fileType) {
            throw new Error(
                `Book ${payload.bookId} file type changed from ${payload.fileType} to ${book.fileType}`
            );
        }

        log.info("Processing book", {
            bookId: payload.bookId,
            fileKey: payload.fileKey,
        });

        const result = await processBook({
            bookId: payload.bookId,
            fileKey: payload.fileKey,
            fileType: payload.fileType,
        });

        await repository.markReady(payload.bookId, result.collectionName);
        const duration = Date.now() - start;
        log.info("Uploaded book processing succeeded", {
            bookId: payload.bookId,
            collectionName: result.collectionName,
            chunkCount: result.chunks,
            reusedCollection: result.reusedCollection,
            durationMs: duration,
        });
        return result;
    } catch (error) {
        const duration = Date.now() - start;
        log.error("Uploaded book processing failed", {
            bookId: payload.bookId,
            fileKey: payload.fileKey,
            durationMs: duration,
            error: getErrorMessage(error),
        });
        if (options.markFailedOnError ?? true) {
            await repository.markFailed(payload.bookId, getErrorMessage(error));
        } else {
            log.warn("Skipping markFailed for book", {
                bookId: payload.bookId,
            });
        }
        throw error;
    }
};

export const processUploadedBook = async (
    payload: ProcessUploadedBookPayload,
    options: ProcessUploadedBookOptions = {}
): Promise<ProcessBookResult> => {
    log.info("Processing uploaded book (worker entry)", {
        bookId: payload.bookId,
        userId: payload.userId,
        fileKey: payload.fileKey,
        fileType: payload.fileType,
    });
    const result = await handleProcessUploadedBook(
        payload,
        bookProcessingRepository,
        (input) =>
            processBookForSearch(input, {
                storage: storageProvider,
                vectorStore,
                searchIndexStore: bookSearchChunkStore,
            }),
        options
    );
    log.info("Clearing hybrid search cache after processing", {
        collectionName: result.collectionName,
    });
    hybridBookSearchService.clearCollectionCache(result.collectionName);
    return result;
};
