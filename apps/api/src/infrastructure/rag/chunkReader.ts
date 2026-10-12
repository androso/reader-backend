import type { BookChunkReader } from "@reader/application";
import type { Database } from "../../database/database.module";
import { createBookSearchChunkStore } from "../../services/BookSearchChunkStore";

export const createBookChunkReader = (database: Database): BookChunkReader => {
    const store = createBookSearchChunkStore(database);
    return {
        getCollectionChunks: (collectionName) =>
            store.getCollectionChunks(collectionName),
    };
};
