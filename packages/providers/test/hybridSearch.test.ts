import assert from "node:assert/strict";
import test from "node:test";
import {
    HybridBookSearchService,
    type BookSearchChunk,
} from "../src/hybridSearch";
import type { VectorSearchResult } from "../src/vectorStore";

const chunks: BookSearchChunk[] = [
    {
        id: "book_test_0",
        collectionName: "book_test",
        chunkIndex: 0,
        content: "Alice followed the White Rabbit down the passage.",
    },
    {
        id: "book_test_1",
        collectionName: "book_test",
        chunkIndex: 1,
        content: "A bicycle leaned against the garden wall.",
    },
];

const createService = (semanticResults: VectorSearchResult[] = []) =>
    new HybridBookSearchService(
        {
            getCollectionChunks: async () => chunks,
        },
        {
            searchDocuments: async () => semanticResults,
        }
    );

test("minimum score filters weak single-channel hybrid matches", async () => {
    const service = createService();

    const results = await service.search("book_test", "bicycle", {
        vectorLimit: 0,
        minScore: 0.03,
    });

    assert.deepEqual(results, []);
});

test("minimum score keeps results with lexical and semantic agreement", async () => {
    const service = createService([
        {
            id: "book_test_0",
            content: chunks[0].content,
            rank: 1,
        },
        {
            id: "book_test_1",
            content: chunks[1].content,
            rank: 2,
        },
    ]);

    const results = await service.search("book_test", "rabbit", {
        minScore: 0.03,
    });

    assert.deepEqual(
        results.map((result) => result.id),
        ["book_test_0"]
    );
});

test("diagnostics preserve candidate and selected result ordering", async () => {
    const service = createService([
        {
            id: "book_test_0",
            content: chunks[0].content,
            rank: 2,
            distance: 0.2,
        },
        {
            id: "book_test_1",
            content: chunks[1].content,
            rank: 1,
            distance: 0.1,
        },
    ]);

    const response = await service.searchWithDiagnostics(
        "book_test",
        "rabbit",
        { finalLimit: 2 }
    );
    const legacyResults = await service.search("book_test", "rabbit", {
        finalLimit: 2,
    });

    assert.deepEqual(response.results, legacyResults);
    assert.equal(response.diagnostics.mode, "hybrid");
    assert.deepEqual(
        response.diagnostics.vectorCandidates.map((candidate) => candidate.id),
        ["book_test_0", "book_test_1"]
    );
    assert.deepEqual(
        response.diagnostics.selectedCandidates.map(
            (candidate) => candidate.id
        ),
        response.results.map((result) => result.id)
    );
    assert.ok(response.diagnostics.durationMs >= 0);
});
