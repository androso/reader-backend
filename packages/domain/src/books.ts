export type BookFileType = "epub" | "pdf";

export const BOOK_PROCESSING_STATUSES = [
    "processing",
    "ready",
    "failed",
    "queue_failed",
    "deleting",
] as const;

export type BookProcessingStatus = (typeof BOOK_PROCESSING_STATUSES)[number];

export const RETRYABLE_BOOK_STATUSES = ["failed", "queue_failed"] as const;

export interface Book {
    id: string;
    title: string;
    userId: string;
    fileKey: string;
    fileType: BookFileType | null;
    collectionName: string | null;
    processingStatus: string;
    processingError: string | null;
    createdAt: Date;
}

export interface NewBook {
    id: string;
    title: string;
    userId: string;
    fileKey: string;
    fileType: BookFileType;
    processingStatus: "processing";
    processingError: null;
}

export interface BookProcessingRequest {
    bookId: string;
    userId: string;
    fileKey: string;
    fileType: BookFileType;
}

export interface BookIngestionInput {
    bookId: string;
    fileKey: string;
    fileType: BookFileType;
    collectionName: string;
    signal?: AbortSignal;
}

export interface BookIngestionResult {
    collectionName: string;
    chunks: number;
    reusedCollection: boolean;
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

export interface ProcessUploadedBookOptions {
    markFailedOnError?: boolean;
}

export const getBookMimeType = (fileType: BookFileType) =>
    fileType === "pdf" ? "application/pdf" : "application/epub+zip";

export const createOriginalUploadKey = (userId: string, bookId: string) =>
    `users/${userId}/books/${bookId}/original`;

export const isBookReady = (
    book: Pick<Book, "processingStatus" | "collectionName">
) => book.processingStatus === "ready" && Boolean(book.collectionName);

export class MissingBookFileError extends Error {
    constructor() {
        super("No file uploaded");
        this.name = "MissingBookFileError";
    }
}

export class InvalidBookFileError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "InvalidBookFileError";
    }
}

export class BookProcessingQueueUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BookProcessingQueueUnavailableError";
    }
}

export class BookNotFoundError extends Error {
    constructor(bookId: string) {
        super(`Book ${bookId} was not found`);
        this.name = "BookNotFoundError";
    }
}

export class BookAccessDeniedError extends Error {
    constructor(bookId: string) {
        super(`Not authorized to access book ${bookId}`);
        this.name = "BookAccessDeniedError";
    }
}

export class BookNotRetryableError extends Error {
    constructor(bookId: string, status: string) {
        super(`Book ${bookId} is not retryable in status ${status}`);
        this.name = "BookNotRetryableError";
    }
}

export class BookProcessingBusyError extends Error {
    constructor(bookId: string) {
        super(`Book processing is already in progress for ${bookId}`);
        this.name = "BookProcessingBusyError";
    }
}

export class BookLifecycleLockTimeoutError extends Error {
    constructor(bookId: string) {
        super(`Book lifecycle lock timed out for ${bookId}`);
        this.name = "BookLifecycleLockTimeoutError";
    }
}

export class BookLifecycleLockUnavailableError extends Error {
    readonly cause?: unknown;

    constructor(bookId: string, cause?: unknown) {
        super(`Book lifecycle lock unavailable for ${bookId}`);
        this.name = "BookLifecycleLockUnavailableError";
        this.cause = cause;
    }
}

export class BookLifecycleLockLostError extends BookLifecycleLockUnavailableError {
    constructor(bookId: string, cause?: unknown) {
        super(bookId, cause);
        this.name = "BookLifecycleLockLostError";
    }
}

export type BookProcessingSkipReason =
    | "missing"
    | "ready"
    | "deleting"
    | "not_processing"
    | "publication_rejected";

export class BookProcessingSkippedError extends Error {
    constructor(
        readonly bookId: string,
        readonly reason: BookProcessingSkipReason
    ) {
        super(`Book processing skipped for ${bookId}: ${reason}`);
        this.name = "BookProcessingSkippedError";
    }
}

export class BookFileTypeMismatchError extends Error {
    constructor(
        bookId: string,
        expected: BookFileType,
        actual: BookFileType | null
    ) {
        super(`Book ${bookId} file type changed from ${expected} to ${actual}`);
        this.name = "BookFileTypeMismatchError";
    }
}

export class BookDeletedDuringProcessingError extends BookProcessingSkippedError {
    constructor(bookId: string) {
        super(bookId, "publication_rejected");
        this.message = `Book ${bookId} was deleted during processing`;
        this.name = "BookDeletedDuringProcessingError";
    }
}
