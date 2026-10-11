import { eq } from "drizzle-orm";
import {
    deleteFile,
    getFile,
    uploadFile,
    vectorStore,
} from "@reader/providers";
import type { BookProcessingRequest } from "@reader/domain";
import type { Database } from "../database/database.module";
import { Books } from "../db/schema";
import { createBookSearchChunkStore } from "../services/BookSearchChunkStore";
import { hybridBookSearchService } from "../services/HybridBookSearchService";
import { createEnqueueBookProcessing } from "../infrastructure/books";
import type { BookFileDependencies } from "./book-file.handler";

export const BOOKS_PORTS = "BOOKS_PORTS";

export interface BooksPorts {
    uploadFile: typeof uploadFile;
    deleteFile: typeof deleteFile;
    deleteVectorCollection: (collectionName: string) => Promise<unknown>;
    deleteCollectionChunks: (collectionName: string) => Promise<void>;
    clearCollectionCache: (collectionName: string) => void;
    enqueueBookProcessing: (request: BookProcessingRequest) => Promise<void>;
    bookFile: BookFileDependencies;
}

export const createBookFileDependencies = (
    database: Database,
    readFile: (fileKey: string) => Promise<Buffer>
): BookFileDependencies => ({
    async findBookById(bookId) {
        const [book] = await database
            .select()
            .from(Books)
            .where(eq(Books.id, bookId));
        return book;
    },
    getFile: readFile,
});

export const createBooksPorts = (database: Database): BooksPorts => {
    const chunkStore = createBookSearchChunkStore(database);
    const enqueueBookProcessing = createEnqueueBookProcessing(database);
    return {
        uploadFile,
        deleteFile,
        deleteVectorCollection: (collectionName) =>
            vectorStore.deleteCollection(collectionName),
        deleteCollectionChunks: (collectionName) =>
            chunkStore.deleteCollectionChunks(collectionName),
        clearCollectionCache: (collectionName) =>
            hybridBookSearchService.clearCollectionCache(collectionName),
        enqueueBookProcessing: (request) =>
            enqueueBookProcessing.execute(request),
        bookFile: createBookFileDependencies(database, getFile),
    };
};
