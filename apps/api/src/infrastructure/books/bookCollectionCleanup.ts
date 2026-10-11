import type { BookCollectionCleanup } from "@reader/application";
import type { Database } from "../../database/database.module";
import { createBookSearchChunkStore } from "../../services/BookSearchChunkStore";
import { createBookArtifactCleanup } from "./bookArtifactCleanup";

export const createBookCollectionCleanup = (
    database?: Database
): BookCollectionCleanup => {
    const chunkStore = database
        ? createBookSearchChunkStore(database)
        : createBookSearchChunkStore();
    const artifactCleanup = createBookArtifactCleanup({
        deleteSearchChunks: (name) => chunkStore.deleteCollectionChunks(name),
    });
    return {
        async deleteCollection(name) {
            await artifactCleanup.deleteVectorCollection(name);
            await artifactCleanup.deleteSearchChunks(name);
        },
    };
};
