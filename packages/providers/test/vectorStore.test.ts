import assert from "node:assert/strict";
import test from "node:test";
import { type ChromaClient } from "chromadb";
import {
    ChromaVectorStore,
    isCollectionNotFoundError,
} from "../src/vectorStore";

type ChromaCollection = Awaited<ReturnType<ChromaClient["createCollection"]>>;

const collection = {} as ChromaCollection;

test("reset creates a collection when Chroma reports it missing", async () => {
    const createdCollections: string[] = [];
    const store = new ChromaVectorStore({
        createCollection: async ({ name }) => {
            createdCollections.push(name);
            return collection;
        },
        deleteCollection: async () => {
            const error = new Error(
                "The requested resource could not be found"
            );
            error.name = "ChromaNotFoundError";
            throw error;
        },
        getCollection: async () => collection,
    });

    await store.resetCollection("book_missing");

    assert.deepEqual(createdCollections, ["book_missing"]);
});

test("reset rethrows non-not-found Chroma failures", async () => {
    const deleteError = new Error("Chroma connection failed");
    let collectionCreated = false;
    const store = new ChromaVectorStore({
        createCollection: async () => {
            collectionCreated = true;
            return collection;
        },
        deleteCollection: async () => {
            throw deleteError;
        },
        getCollection: async () => collection,
    });

    await assert.rejects(
        store.resetCollection("book_unavailable"),
        (error) => error === deleteError
    );
    assert.equal(collectionCreated, false);
});

const missingCollection = (name = "InvalidCollectionError") =>
    Object.assign(new Error("Collection book_missing does not exist."), {
        name,
    });

test("reset creates a fresh collection after Chroma 0.6 reports InvalidArgumentError", async () => {
    const calls: string[] = [];
    const store = new ChromaVectorStore({
        createCollection: async ({ name }) => {
            calls.push(`create:${name}`);
            return collection;
        },
        deleteCollection: async ({ name }) => {
            calls.push(`delete:${name}`);
            throw missingCollection("InvalidArgumentError");
        },
        getCollection: async () => collection,
    });
    await store.resetCollection("book_missing");
    assert.deepEqual(calls, ["delete:book_missing", "create:book_missing"]);
});

test("a missing collection can be created through getOrCreateCollection", async () => {
    let creates = 0;
    const store = new ChromaVectorStore({
        createCollection: async () => {
            creates += 1;
            return collection;
        },
        deleteCollection: async () => {},
        getCollection: async () => {
            throw missingCollection();
        },
    });
    assert.equal(await store.getOrCreateCollection("book_missing"), collection);
    assert.equal(creates, 1);
});

test("deleting an absent collection is idempotent and clears stale cache entries", async () => {
    let reads = 0;
    const store = new ChromaVectorStore({
        createCollection: async () => collection,
        deleteCollection: async () => {
            throw missingCollection("InvalidArgumentError");
        },
        getCollection: async () => {
            reads += 1;
            if (reads === 1) return collection;
            throw missingCollection();
        },
    });
    assert.equal(await store.getCollection("book_missing"), collection);
    assert.equal(await store.deleteCollection("book_missing"), false);
    assert.equal(await store.getCollection("book_missing"), null);
    assert.equal(reads, 2);
});

test("successful deletion returns true and unexpected deletion failures propagate", async () => {
    const failure = new Error("Chroma connection failed");
    let fail = false;
    const store = new ChromaVectorStore({
        createCollection: async () => collection,
        deleteCollection: async () => {
            if (fail) throw failure;
        },
        getCollection: async () => collection,
    });
    assert.equal(await store.deleteCollection("book_present"), true);
    fail = true;
    await assert.rejects(
        store.deleteCollection("book_present"),
        (error) => error === failure
    );
});

test("invalid collection requests are not all treated as absent collections", () => {
    assert.equal(isCollectionNotFoundError(missingCollection()), true);
    assert.equal(
        isCollectionNotFoundError(missingCollection("InvalidArgumentError")),
        true
    );
    assert.equal(
        isCollectionNotFoundError({
            name: "InvalidCollectionException",
            message: "Collection book_missing does not exist",
        }),
        true
    );
    assert.equal(
        isCollectionNotFoundError({
            name: "InvalidArgumentError",
            message: "Collection name is invalid",
        }),
        false
    );
    assert.equal(
        isCollectionNotFoundError({
            name: "AuthenticationError",
            message: "Collection book_missing does not exist.",
        }),
        false
    );
});
