import assert from "node:assert/strict";
import test from "node:test";
import { type ChromaClient } from "chromadb";
import { ChromaVectorStore } from "../src/vectorStore";

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
