import type {
    Book,
    BookFileType,
    BookIngestionInput,
    BookIngestionResult,
    BookProcessingRecord,
    BookProcessingRequest,
    NewBook,
    RETRYABLE_BOOK_STATUSES,
} from "@reader/domain";

export interface Logger {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
};

export interface IdGenerator {
    next(): string;
}

export interface BookFileValidator {
    detectFileType(buffer: Uint8Array): Promise<BookFileType>;
}

export interface BookFileStorage {
    save(fileKey: string, buffer: Uint8Array): Promise<void>;
    getFile(fileKey: string): Promise<Uint8Array>;
}

export class StoredBookFileNotFoundError extends Error {
    constructor() {
        super("Stored book file was not found");
        this.name = "StoredBookFileNotFoundError";
    }
}

export interface BookRepository {
    create(book: NewBook): Promise<Book>;
    findById(bookId: string): Promise<Book | null>;
}

export interface BookProcessingScheduler {
    schedule(request: BookProcessingRequest): Promise<void>;
}

export interface BookProcessingQueue {
    enqueue(request: BookProcessingRequest): Promise<void>;
}

export interface BookQueueStateRepository {
    markQueueFailed(
        bookId: string,
        userId: string,
        error: string
    ): Promise<boolean>;
}

export interface BookProcessingRepository {
    findBookForProcessing(
        bookId: string,
        userId: string
    ): Promise<BookProcessingRecord | null>;
    markReady(
        bookId: string,
        userId: string,
        collectionName: string
    ): Promise<boolean>;
    markFailed(bookId: string, userId: string, error: string): Promise<boolean>;
}

export type RetryableBookStatus = (typeof RETRYABLE_BOOK_STATUSES)[number];

export interface BookReadRepository {
    findById(bookId: string): Promise<Book | null>;
    findOwned(bookId: string, userId: string): Promise<Book | null>;
    listByOwner(userId: string): Promise<Book[]>;
}

export interface BookRetryStateRepository {
    claimRetry(
        bookId: string,
        userId: string,
        expectedStatus: RetryableBookStatus
    ): Promise<Book | null>;
    restoreRetryable(
        bookId: string,
        userId: string,
        status: RetryableBookStatus,
        error: string | null
    ): Promise<boolean>;
}

export interface BookDeletionRepository {
    markDeleting(bookId: string, userId: string): Promise<boolean>;
    deleteDeletingRow(bookId: string, userId: string): Promise<boolean>;
}

export interface BookArtifactReferences {
    countLiveFileReferences(
        fileKey: string,
        excludingBookId: string
    ): Promise<number>;
    countLiveCollectionReferences(
        collectionName: string,
        excludingBookId: string
    ): Promise<number>;
}

export interface BookArtifactCleanup {
    deleteFile(fileKey: string): Promise<void>;
    deleteVectorCollection(collectionName: string): Promise<void>;
    deleteSearchChunks(collectionName: string): Promise<void>;
    clearCache(collectionName: string): void;
    defaultCollectionName(bookId: string): string;
}

export interface BookQueueControl {
    retryOrEnqueue(
        request: BookProcessingRequest
    ): Promise<"retried" | "enqueued">;
    removePending(bookId: string): Promise<void>;
}

export interface BookLifecycleLock {
    withLock<T>(
        bookId: string,
        fn: (signal: AbortSignal) => Promise<T>
    ): Promise<T>;
}

export interface BookIngestion {
    ingest(input: BookIngestionInput): Promise<BookIngestionResult>;
}

export interface BookCollectionCleanup {
    deleteCollection(collectionName: string): Promise<void>;
    defaultCollectionName(bookId: string): string;
    attemptCollectionName(bookId: string, attemptId: string): string;
}

export interface BookSearchCache {
    clearCollection(collectionName: string): void;
}

export interface UploadBookFile {
    originalName: string;
    buffer: Uint8Array;
}
