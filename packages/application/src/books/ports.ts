import type {
    Book,
    BookFileType,
    BookIngestionInput,
    BookIngestionResult,
    BookProcessingRecord,
    BookProcessingRequest,
    NewBook,
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
    markQueueFailed(bookId: string, error: string): Promise<void>;
}

export interface BookProcessingRepository {
    findBookForProcessing(
        bookId: string,
        userId: string
    ): Promise<BookProcessingRecord | null>;
    markReady(bookId: string, collectionName: string): Promise<boolean>;
    markFailed(bookId: string, error: string): Promise<void>;
}

export interface BookIngestion {
    ingest(input: BookIngestionInput): Promise<BookIngestionResult>;
}

export interface BookCollectionCleanup {
    deleteCollection(collectionName: string): Promise<void>;
}

export interface BookSearchCache {
    clearCollection(collectionName: string): void;
}

export interface UploadBookFile {
    originalName: string;
    buffer: Uint8Array;
}
