import { randomUUID } from "node:crypto";
import {
    EnqueueBookProcessing,
    ProcessUploadedBook,
    UploadBook,
} from "@reader/application";
import type { BookProcessingRequest } from "@reader/domain";
import { createLogger, uploadFile } from "@reader/providers";
import type { Database } from "../../database/database.module";
import { db } from "../../db";
import { createBookCollectionCleanup } from "./bookCollectionCleanup";
import { createBookIngestion } from "./bookIngestion";
import { bookSearchCache } from "./bookSearchCache";
import { createDrizzleBookRepository } from "./drizzleBookRepository";
import { bullmqBookProcessingQueue } from "./bullmqBookProcessingQueue";
import { bookUploadValidator } from "./bookUploadValidator";
import { createBookSearchChunkStore } from "../../services/BookSearchChunkStore";

export const createEnqueueBookProcessing = (database: Database) => {
    const repository = createDrizzleBookRepository(database);
    return new EnqueueBookProcessing({
        queue: bullmqBookProcessingQueue,
        repository,
        logger: createLogger("BookProcessingEnqueueService"),
    });
};

export const createProcessUploadedBook = (database: Database = db) => {
    const repository = createDrizzleBookRepository(database);
    const chunkStore = createBookSearchChunkStore(database);
    return new ProcessUploadedBook({
        repository,
        ingestion: createBookIngestion(chunkStore),
        cleanup: createBookCollectionCleanup(database),
        cache: bookSearchCache,
        logger: createLogger("BookProcessingService"),
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
    createBookCollectionCleanup,
    createBookIngestion,
    createDrizzleBookRepository,
};
