import assert from "node:assert/strict";
import test from "node:test";
import { HybridBookSearchService } from "../src/services/HybridBookSearchService";
import type { BookSearchChunk } from "../src/services/BookSearchChunkStore";
import type { VectorSearchResult } from "@reader/providers";
import {
    maskLangfuseAttribute,
    withBookChatTrace,
} from "../src/observability/langfuse";

const chunks: BookSearchChunk[] = [
    {
        id: "book_test_0",
        collectionName: "book_test",
        chunkIndex: 0,
        content: "Dragons guard the old mountain gate.",
    },
    {
        id: "book_test_1",
        collectionName: "book_test",
        chunkIndex: 1,
        content: "The ship crossed the western sea at dawn.",
    },
    {
        id: "book_test_2",
        collectionName: "book_test",
        chunkIndex: 2,
        content: "A quiet library held maps of every kingdom.",
        metadata: {
            chapterTitle: "Maps",
            chapterIndex: 3,
        },
    },
];

const restoreEnv = (name: string, value: string | undefined) => {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
};

const createService = (
    semanticResults: VectorSearchResult[] = [],
    indexedChunks = chunks
) => {
    let loadCount = 0;
    const service = new HybridBookSearchService(
        {
            getCollectionChunks: async () => {
                loadCount += 1;
                return indexedChunks;
            },
        },
        {
            searchDocuments: async () => semanticResults,
        }
    );

    return { service, getLoadCount: () => loadCount };
};

test("MiniSearch lexical match contributes to hybrid results", async () => {
    const { service } = createService();

    const results = await service.search("book_test", "dragons", {
        vectorLimit: 0,
        finalLimit: 2,
    });

    assert.equal(results[0].id, "book_test_0");
    assert.match(results[0].content, /Dragons/);
});

test("RRF fuses semantic and lexical rankings by chunk id", async () => {
    const { service } = createService([
        {
            id: "book_test_2",
            content: chunks[2].content,
            rank: 1,
        },
        {
            id: "book_test_0",
            content: chunks[0].content,
            rank: 2,
        },
    ]);

    const results = await service.search("book_test", "dragons", {
        finalLimit: 3,
    });

    assert.equal(results[0].id, "book_test_0");
    assert.ok(results.some((result) => result.id === "book_test_2"));
});

test("falls back to semantic results when MiniSearch chunks are missing", async () => {
    const { service } = createService(
        [
            {
                id: "book_test_1",
                content: chunks[1].content,
                rank: 1,
            },
        ],
        []
    );

    const results = await service.search("book_test", "sea", {
        finalLimit: 1,
    });

    assert.deepEqual(
        results.map((result) => result.id),
        ["book_test_1"]
    );
});

test("hydrates metadata for semantic-only results", async () => {
    const { service } = createService([
        {
            id: "book_test_2",
            content: chunks[2].content,
            rank: 1,
        },
    ]);

    const results = await service.search("book_test", "cartography", {
        finalLimit: 1,
    });

    assert.equal(results[0].id, "book_test_2");
    assert.deepEqual(results[0].metadata, chunks[2].metadata);
});

test("reuses the cached MiniSearch index for the same collection", async () => {
    const { service, getLoadCount } = createService();

    await service.search("book_test", "dragons", { vectorLimit: 0 });
    await service.search("book_test", "library", { vectorLimit: 0 });

    assert.equal(getLoadCount(), 1);
});

test("hybrid search runs through disabled Langfuse tracing", async () => {
    const previousPublicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const previousSecretKey = process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    const { service } = createService();

    try {
        const results = await withBookChatTrace(
            {
                userId: "user-1",
                conversationId: "conversation-1",
                resourceType: "book",
                resourceId: "book-1",
                routeName: "test",
                messageCount: 1,
                queryLength: "dragons".length,
            },
            (trace) =>
                service.search(
                    "book_test",
                    "dragons",
                    { vectorLimit: 0 },
                    { trace, capture: { mode: "metadata", maxChars: 100 } }
                )
        );

        assert.equal(results[0].id, "book_test_0");
    } finally {
        restoreEnv("LANGFUSE_PUBLIC_KEY", previousPublicKey);
        restoreEnv("LANGFUSE_SECRET_KEY", previousSecretKey);
    }
});

test("Langfuse mask preserves stringified input and output attributes", () => {
    const masked = maskLangfuseAttribute(
        JSON.stringify({
            query: "What happened in chapter one?",
            metadata: {
                routeName: "chat",
            },
        }),
        { mode: "metadata", maxChars: 100 }
    );

    assert.equal(typeof masked, "string");
    assert.deepEqual(JSON.parse(masked as string), {
        query: "[redacted]",
        metadata: {
            routeName: "chat",
        },
    });
});
