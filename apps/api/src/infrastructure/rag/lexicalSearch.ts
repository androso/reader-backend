import type { LexicalSearch } from "@reader/application";
import {
    getLangfuseCaptureConfig,
    type TraceObservation,
} from "../../observability/langfuse";
import type { HybridBookSearchService } from "@reader/providers";
import { hybridBookSearchService } from "../../services/HybridBookSearchService";

export const createLexicalSearchAdapter = (
    service: Pick<
        HybridBookSearchService,
        "searchLexical" | "getCollectionChunks" | "clearCollectionCache"
    >
): LexicalSearch => ({
    search(collectionName, query, limit, options) {
        return service.searchLexical(collectionName, query, limit, {
            trace: options?.trace as TraceObservation | undefined,
            capture: getLangfuseCaptureConfig(),
        });
    },
    getCollectionChunks(collectionName) {
        return service.getCollectionChunks(collectionName);
    },
    clearCollectionCache(collectionName) {
        service.clearCollectionCache(collectionName);
    },
});

export const lexicalSearch = createLexicalSearchAdapter(
    hybridBookSearchService
);
