import {
    HybridBookSearchService as SharedHybridBookSearchService,
    vectorStore,
    type BookSearchChunk,
    type BookSearchChunkMetadata,
    type BookSearchChunkReader,
    type RankedSearchResult,
} from "@reader/providers";
import { bookSearchChunkStore } from "./BookSearchChunkStore";

export {
    SharedHybridBookSearchService as HybridBookSearchService,
    type BookSearchChunk,
    type BookSearchChunkMetadata,
    type BookSearchChunkReader,
    type RankedSearchResult,
};

export const hybridBookSearchService = new SharedHybridBookSearchService(
    bookSearchChunkStore,
    vectorStore
);
