import assert from "node:assert/strict";
import test from "node:test";
import { contentFreeQueryLogMetadata } from "../src/logger";

test("retrieval query log metadata never contains raw query text", () => {
    const query = "private sampled user question";
    const metadata = contentFreeQueryLogMetadata(query, {
        collectionName: "book_collection",
    });

    assert.deepEqual(metadata, {
        collectionName: "book_collection",
        queryLength: query.length,
    });
    assert.equal(JSON.stringify(metadata).includes(query), false);
    assert.equal("query" in metadata, false);
});
