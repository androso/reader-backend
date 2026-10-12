import { randomBytes } from "node:crypto";
import { ProcessUploadedBook } from "@reader/application";
import type {
    BookArtifactReferences,
    BookCollectionCleanup,
    BookLifecycleLock,
    BookProcessingRepository as BookProcessingRepositoryPort,
} from "@reader/application";
import type {
    BookProcessingRecord,
    BookProcessingRequest,
    ProcessUploadedBookOptions,
} from "@reader/domain";
import { createLogger } from "@reader/providers";
import {
    processBookForSearch,
    type ProcessBookResult,
} from "@reader/processing";
import {
    createBookCollectionCleanup,
    createDrizzleBookRepository,
    createPostgresBookLifecycleLock,
    createProcessUploadedBook,
} from "../infrastructure/books";
import { db, pool } from "../db";

const log = createLogger("BookProcessingService");

export type ProcessUploadedBookPayload = BookProcessingRequest;
export type { BookProcessingRecord, ProcessUploadedBookOptions };
export type BookProcessingRepository = BookProcessingRepositoryPort;
export type ProcessBookForSearch = typeof processBookForSearch;

export interface ProcessBookLifecycleDependencies {
    lock?: BookLifecycleLock;
    references?: BookArtifactReferences;
    cleanup?: BookCollectionCleanup;
    attemptIds?: { next(): string };
}

export const handleProcessUploadedBook = async (
    payload: ProcessUploadedBookPayload,
    repository: BookProcessingRepository,
    processBook: ProcessBookForSearch,
    options: ProcessUploadedBookOptions = {},
    lifecycle: ProcessBookLifecycleDependencies = {}
): Promise<ProcessBookResult> => {
    const bookRepository = createDrizzleBookRepository(db);
    const processor = new ProcessUploadedBook({
        repository,
        ingestion: { ingest: processBook },
        cleanup: lifecycle.cleanup ?? createBookCollectionCleanup(),
        references: lifecycle.references ?? bookRepository,
        lock: lifecycle.lock ?? createPostgresBookLifecycleLock({ pool }),
        cache: { clearCollection() {} },
        attemptIds: lifecycle.attemptIds ?? {
            next: () => randomBytes(4).toString("hex"),
        },
        logger: log,
    });
    return processor.execute(payload, options);
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
    return createProcessUploadedBook().execute(payload, options);
};
