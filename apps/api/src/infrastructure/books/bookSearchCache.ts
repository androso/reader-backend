import type { BookSearchCache } from "@reader/application";
import type { LexicalSearch } from "@reader/application";
import { lexicalSearch } from "../rag/lexicalSearch";

export const createBookSearchCache = (
    lexical: Pick<LexicalSearch, "clearCollectionCache">
): BookSearchCache => ({
    clearCollection: (collectionName) =>
        lexical.clearCollectionCache?.(collectionName),
});

export const bookSearchCache = createBookSearchCache(lexicalSearch);
