import type { BookCollectionCleanup } from "@reader/application";
import { vectorStore } from "@reader/providers";
import type { Database } from "../../database/database.module";
import { createBookSearchChunkStore } from "../../services/BookSearchChunkStore";

export const createBookCollectionCleanup = (
    database?: Database
): BookCollectionCleanup => {
    const chunkStore = database
        ? createBookSearchChunkStore(database)
        : createBookSearchChunkStore();
    return {
        async deleteCollection(collectionName) {
            await vectorStore.deleteCollection(collectionName);
            await chunkStore.deleteCollectionChunks(collectionName);
        },
    };
};
