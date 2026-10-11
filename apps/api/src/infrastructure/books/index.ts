import { randomUUID } from "node:crypto";
import {
    DeleteOwnedBook,
    EnqueueBookProcessing,
    GetBookStatus,
    ListOwnedBooks,
    ProcessUploadedBook,
    RetryBookProcessing,
    UploadBook,
} from "@reader/application";
import type { BookProcessingRequest } from "@reader/domain";
import { createLogger, uploadFile } from "@reader/providers";
import type { Database } from "../../database/database.module";
import { db } from "../../db";
import { pool } from "../../db";
import { createBookCollectionCleanup } from "./bookCollectionCleanup";
import { createBookArtifactCleanup } from "./bookArtifactCleanup";
import { createBookIngestion } from "./bookIngestion";
import { bookSearchCache } from "./bookSearchCache";
import { createDrizzleBookRepository } from "./drizzleBookRepository";
import { bullmqBookProcessingQueue } from "./bullmqBookProcessingQueue";
import { createBullMqBookQueueControl } from "./bullmqBookQueueControl";
import { bookUploadValidator } from "./bookUploadValidator";
import { createBookSearchChunkStore } from "../../services/BookSearchChunkStore";
import { createPostgresBookLifecycleLock } from "./postgresBookLifecycleLock";
import type { Pool } from "pg";

export const createEnqueueBookProcessing = (database: Database) => {
    const repository = createDrizzleBookRepository(database);
    return new EnqueueBookProcessing({
        queue: bullmqBookProcessingQueue,
        repository,
        logger: createLogger("BookProcessingEnqueueService"),
    });
};

export const createProcessUploadedBook = (
    database: Database = db,
    connectionPool: Pick<Pool, "connect"> = pool
) => {
    const repository = createDrizzleBookRepository(database);
    const chunkStore = createBookSearchChunkStore(database);
    return new ProcessUploadedBook({
        repository,
        ingestion: createBookIngestion(chunkStore),
        cleanup: createBookCollectionCleanup(database),
        references: repository,
        lock: createPostgresBookLifecycleLock({ pool: connectionPool }),
        cache: bookSearchCache,
        logger: createLogger("BookProcessingService"),
    });
};

export const createListOwnedBooks = (database: Database) =>
    new ListOwnedBooks({ repository: createDrizzleBookRepository(database) });

export const createGetBookStatus = (database: Database) =>
    new GetBookStatus({ repository: createDrizzleBookRepository(database) });

export const createRetryBookProcessing = (
    database: Database,
    connectionPool: Pick<Pool, "connect"> = pool
) => {
    const repository = createDrizzleBookRepository(database);
    return new RetryBookProcessing({
        reads: repository,
        retryState: repository,
        queueState: repository,
        queue: createBullMqBookQueueControl(),
        lock: createPostgresBookLifecycleLock({ pool: connectionPool }),
        logger: createLogger("BookProcessingService"),
    });
};

export const createDeleteOwnedBook = (
    database: Database,
    connectionPool: Pick<Pool, "connect"> = pool
) => {
    const repository = createDrizzleBookRepository(database);
    const chunkStore = createBookSearchChunkStore(database);
    const cleanup = createBookArtifactCleanup({
        deleteSearchChunks: (collectionName) =>
            chunkStore.deleteCollectionChunks(collectionName),
    });
    return new DeleteOwnedBook({
        reads: repository,
        deletion: repository,
        references: repository,
        cleanup,
        queue: createBullMqBookQueueControl(),
        lock: createPostgresBookLifecycleLock({ pool: connectionPool }),
        logger: createLogger("books"),
    });
};

export const createUploadBook = (
    database: Database,
    ports: {
        uploadFile: typeof uploadFile;
        enqueueBookProcessing: (
            request: BookProcessingRequest
        ) => Promise<void>;
    }
) =>
    new UploadBook({
        ids: { next: randomUUID },
        validator: bookUploadValidator,
        storage: {
            save: async (fileKey, buffer) => {
                await ports.uploadFile(fileKey, buffer as Buffer);
            },
        },
        books: createDrizzleBookRepository(database),
        scheduler: { schedule: ports.enqueueBookProcessing },
        logger: createLogger("books"),
    });

export {
    createBookArtifactCleanup,
    createBookCollectionCleanup,
    createBookIngestion,
    createDrizzleBookRepository,
    createBullMqBookQueueControl,
    createPostgresBookLifecycleLock,
};
