import { ProcessUploadedBook } from "@reader/application";
import type { BookProcessingRepository as BookProcessingRepositoryPort } from "@reader/application";
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
    createProcessUploadedBook,
} from "../infrastructure/books";

const log = createLogger("BookProcessingService");

export type ProcessUploadedBookPayload = BookProcessingRequest;
export type { BookProcessingRecord, ProcessUploadedBookOptions };
export type BookProcessingRepository = BookProcessingRepositoryPort;
export type ProcessBookForSearch = typeof processBookForSearch;

export const handleProcessUploadedBook = async (
    payload: ProcessUploadedBookPayload,
    repository: BookProcessingRepository,
    processBook: ProcessBookForSearch,
    options: ProcessUploadedBookOptions = {}
): Promise<ProcessBookResult> => {
    const processor = new ProcessUploadedBook({
        repository,
        ingestion: { ingest: processBook },
        cleanup: createBookCollectionCleanup(),
        cache: { clearCollection() {} },
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
