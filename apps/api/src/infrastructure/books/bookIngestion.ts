import type { BookIngestion } from "@reader/application";
import type { SearchIndexStore } from "@reader/processing";
import { processBookForSearch } from "@reader/processing";
import { storageProvider, vectorStore } from "@reader/providers";
import { bookSearchChunkStore } from "../../services/BookSearchChunkStore";

export const createBookIngestion = (
    chunkStore: SearchIndexStore = bookSearchChunkStore
): BookIngestion => ({
    ingest: (input) =>
        processBookForSearch(input, {
            storage: storageProvider,
            vectorStore,
            searchIndexStore: chunkStore,
        }),
});
