import type { BookCollectionCleanup } from "@reader/application";
import {
    createBookAttemptCollectionName,
    createBookCollectionName,
} from "@reader/processing";
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
        defaultCollectionName: createBookCollectionName,
        attemptCollectionName: createBookAttemptCollectionName,
        async deleteCollection(name) {
            const outcomes = await Promise.allSettled([
                artifactCleanup.deleteVectorCollection(name),
                artifactCleanup.deleteSearchChunks(name),
            ]);
            const failed = outcomes.find(
                (outcome): outcome is PromiseRejectedResult =>
                    outcome.status === "rejected"
            );
            if (failed) throw failed.reason;
        },
    };
};
