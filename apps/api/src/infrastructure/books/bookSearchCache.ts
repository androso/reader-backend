import type { BookSearchCache } from "@reader/application";
import { hybridBookSearchService } from "../../services/HybridBookSearchService";

export const bookSearchCache: BookSearchCache = {
    clearCollection: (collectionName) =>
        hybridBookSearchService.clearCollectionCache(collectionName),
};
