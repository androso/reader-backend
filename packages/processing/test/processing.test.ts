import assert from "node:assert/strict";
import test from "node:test";
import type { StorageProvider, VectorStoreProvider } from "@reader/providers";
import {
    createBookCollectionName,
    processBookForSearch,
    TextChunker,
} from "../src";

const createMockStorage = (file = Buffer.from("book")): StorageProvider => ({
    uploadFile: async () => undefined,
    getFile: async () => file,
    deleteFile: async () => undefined,
});

const createMockVectorStore = () => {
    const calls = {
        resetCollection: [] as string[],
        addDocuments: [] as Array<{
            collectionName: string;
            documents: string[];
        }>,
    };
    const provider: VectorStoreProvider = {
        createCollection: async () => ({}),
        getOrCreateCollection: async () => ({}),
        getCollection: async () => null,
        queryCollection: async () => ({}),
        searchDocuments: async () => [],
        deleteCollection: async () => true,
        resetCollection: async (name) => {
            calls.resetCollection.push(name);
        },
        addDocuments: async (collectionName, documents) => {
            calls.addDocuments.push({ collectionName, documents });
        },
    };

    return { provider, calls };
};

const createMockSearchIndexStore = () => {
    const calls = {
        replaceCollectionChunks: [] as Array<{
            collectionName: string;
            chunks: string[];
        }>,
    };

    return {
        provider: {
            replaceCollectionChunks: async (
                collectionName: string,
                chunks: string[]
            ) => {
                calls.replaceCollectionChunks.push({
                    collectionName,
                    chunks,
                });
            },
        },
        calls,
    };
};

test("preserves a short trailing chunk", () => {
    const chunks = new TextChunker({
        targetChunkSize: 20,
        maxChunkSize: 40,
        minChunkSize: 10,
    }).chunkText("This is a sufficiently long sentence. Tiny.");
    assert.equal(chunks.join(" ").includes("Tiny."), true);
});

test("processes EPUB with mocked storage and vector store", async () => {
    const vector = createMockVectorStore();
    const searchIndex = createMockSearchIndexStore();

    const result = await processBookForSearch(
        {
            bookId: "11111111-1111-1111-1111-111111111111",
            fileKey: "epub-key",
            fileType: "epub",
        },
        {
            storage: createMockStorage(),
            vectorStore: vector.provider,
            searchIndexStore: searchIndex.provider,
            extractEpubChunks: async () => ["one", "two"],
        }
    );

    const collectionName = "book_11111111_1111_1111_1111_111111111111";
    assert.deepEqual(result, {
        collectionName,
        chunks: 2,
        reusedCollection: false,
    });
    assert.deepEqual(vector.calls.resetCollection, [collectionName]);
    assert.deepEqual(vector.calls.addDocuments, [
        { collectionName, documents: ["one", "two"] },
    ]);
    assert.deepEqual(searchIndex.calls.replaceCollectionChunks, [
        { collectionName, chunks: [] },
        { collectionName, chunks: ["one", "two"] },
    ]);
});

test("processes PDF with mocked storage and vector store", async () => {
    const vector = createMockVectorStore();

    const result = await processBookForSearch(
        {
            bookId: "22222222-2222-2222-2222-222222222222",
            fileKey: "pdf-key",
            fileType: "pdf",
        },
        {
            storage: createMockStorage(),
            vectorStore: vector.provider,
            extractPdfChunks: async () => ["pdf text"],
        }
    );

    assert.equal(
        result.collectionName,
        "book_22222222_2222_2222_2222_222222222222"
    );
    assert.equal(result.chunks, 1);
    assert.deepEqual(vector.calls.resetCollection, [
        "book_22222222_2222_2222_2222_222222222222",
    ]);
});

test("different book ids with same metadata use different collections", async () => {
    const vector = createMockVectorStore();

    const first = await processBookForSearch(
        {
            bookId: "33333333-3333-3333-3333-333333333333",
            fileKey:
                "users/user-a/books/33333333-3333-3333-3333-333333333333/original",
            fileType: "epub",
        },
        {
            storage: createMockStorage(Buffer.from("same metadata")),
            vectorStore: vector.provider,
            extractEpubChunks: async () => ["one"],
        }
    );
    const second = await processBookForSearch(
        {
            bookId: "44444444-4444-4444-4444-444444444444",
            fileKey:
                "users/user-b/books/44444444-4444-4444-4444-444444444444/original",
            fileType: "epub",
        },
        {
            storage: createMockStorage(Buffer.from("same metadata")),
            vectorStore: vector.provider,
            extractEpubChunks: async () => ["one"],
        }
    );

    assert.notEqual(first.collectionName, second.collectionName);
    assert.equal(
        first.collectionName,
        "book_33333333_3333_3333_3333_333333333333"
    );
    assert.equal(
        second.collectionName,
        "book_44444444_4444_4444_4444_444444444444"
    );
});

test("fails when processing extracts no chunks", async () => {
    const vector = createMockVectorStore();

    await assert.rejects(
        processBookForSearch(
            {
                bookId: "55555555-5555-5555-5555-555555555555",
                fileKey: "epub-key",
                fileType: "epub",
            },
            {
                storage: createMockStorage(),
                vectorStore: vector.provider,
                extractEpubChunks: async () => [],
            }
        ),
        /No valid text chunks extracted/
    );
});

test("book collection names are derived only from book id", () => {
    assert.equal(
        createBookCollectionName("66666666-6666-6666-6666-666666666666"),
        "book_66666666_6666_6666_6666_666666666666"
    );
});

test("text chunker returns bounded chunks", () => {
    const chunker = new TextChunker({
        minChunkSize: 1,
        targetChunkSize: 20,
        maxChunkSize: 30,
    });

    const chunks = chunker.chunkText(
        "First sentence is here. Second sentence is here. Third sentence is here."
    );

    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 30));
});
