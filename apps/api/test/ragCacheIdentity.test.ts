import assert from "node:assert/strict";
import test from "node:test";
import { HybridBookSearchService } from "@reader/providers";
import { createBookSearchCache } from "../src/infrastructure/books/bookSearchCache";
import { createLexicalSearchAdapter } from "../src/infrastructure/rag/lexicalSearch";

test("book cache clearing invalidates the lexical retrieval adapter cache", async () => {
    let currentContent = "before cache clear";
    const searchService = new HybridBookSearchService(
        {
            getCollectionChunks: async () => [
                {
                    id: "book_0",
                    collectionName: "book",
                    chunkIndex: 0,
                    content: currentContent,
                },
            ],
        },
        { searchDocuments: async () => [] }
    );
    const lexical = createLexicalSearchAdapter(searchService);
    const bookCache = createBookSearchCache(lexical);

    assert.equal((await lexical.search("book", "before", 5)).length, 1);
    currentContent = "after cache clear";
    assert.equal((await lexical.search("book", "after", 5)).length, 0);

    bookCache.clearCollection("book");
    assert.equal((await lexical.search("book", "after", 5)).length, 1);
    assert.strictEqual(bookCache.clearCollection instanceof Function, true);
});
