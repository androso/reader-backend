import type { BookArtifactCleanup } from "@reader/application";
import {
    deleteFile,
    isCollectionNotFoundError,
    vectorStore,
} from "@reader/providers";
import { createBookCollectionName } from "@reader/processing";
import { createBookSearchChunkStore } from "../../services/BookSearchChunkStore";
import { bookSearchCache } from "./bookSearchCache";

export interface BookArtifactCleanupDependencies {
    deleteFile(fileKey: string): Promise<unknown>;
    deleteVectorCollection(collectionName: string): Promise<unknown>;
    deleteSearchChunks(collectionName: string): Promise<void>;
    clearCache(collectionName: string): void;
    defaultCollectionName(bookId: string): string;
}

const isMissingFileError = (error: unknown) => {
    if (!error || typeof error !== "object") return false;
    const details = error as {
        code?: unknown;
        name?: unknown;
        status?: unknown;
        statusCode?: unknown;
    };
    return (
        details.code === "ENOENT" ||
        details.code === "NoSuchKey" ||
        details.name === "NoSuchKey" ||
        details.name === "NotFound" ||
        details.status === 404 ||
        details.statusCode === 404
    );
};

export const createBookArtifactCleanup = (
    overrides: Partial<BookArtifactCleanupDependencies> = {}
): BookArtifactCleanup => {
    const dependencies: BookArtifactCleanupDependencies = {
        deleteFile,
        deleteVectorCollection: (collectionName) =>
            vectorStore.deleteCollection(collectionName),
        deleteSearchChunks: (collectionName) =>
            createBookSearchChunkStore().deleteCollectionChunks(collectionName),
        clearCache: bookSearchCache.clearCollection,
        defaultCollectionName: createBookCollectionName,
        ...overrides,
    };
    return {
        async deleteFile(fileKey) {
            try {
                await dependencies.deleteFile(fileKey);
            } catch (error) {
                if (!isMissingFileError(error)) throw error;
            }
        },

        async deleteVectorCollection(collectionName) {
            try {
                await dependencies.deleteVectorCollection(collectionName);
            } catch (error) {
                if (!isCollectionNotFoundError(error)) throw error;
            }
        },

        deleteSearchChunks: dependencies.deleteSearchChunks,
        clearCache: dependencies.clearCache,
        defaultCollectionName: dependencies.defaultCollectionName,
    };
};

export { isMissingFileError };
