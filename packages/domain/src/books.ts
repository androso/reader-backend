export type BookFileType = "epub" | "pdf";

export const BOOK_PROCESSING_STATUSES = [
    "processing",
    "ready",
    "failed",
    "queue_failed",
    "deleting",
] as const;

export type BookProcessingStatus = (typeof BOOK_PROCESSING_STATUSES)[number];

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

export class BookDeletedDuringProcessingError extends Error {
    constructor(bookId: string) {
        super(`Book ${bookId} was deleted during processing`);
        this.name = "BookDeletedDuringProcessingError";
    }
}
