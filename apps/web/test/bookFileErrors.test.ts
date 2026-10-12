import assert from "node:assert/strict";
import test from "node:test";
import { getBookFileErrorMessage } from "../src/lib/bookFileErrors";

test("missing originals explain restoration or re-upload", async () => {
    const response = Response.json(
        { code: "BOOK_FILE_MISSING" },
        { status: 404 }
    );
    assert.match(
        await getBookFileErrorMessage(response),
        /Restore it from a backup or upload/
    );
});

test("unavailable books and malformed 404 responses have a safe fallback", async () => {
    for (const body of [
        '{"error":"Book was not found"}',
        "<html>Not found</html>",
        "null",
    ]) {
        assert.match(
            await getBookFileErrorMessage(new Response(body, { status: 404 })),
            /book is no longer available/
        );
    }
});

test("authentication, permissions, and server errors stay distinct", async () => {
    assert.match(
        await getBookFileErrorMessage(new Response(null, { status: 401 })),
        /sign in again/
    );
    assert.match(
        await getBookFileErrorMessage(new Response(null, { status: 403 })),
        /permission/
    );
    assert.match(
        await getBookFileErrorMessage(new Response(null, { status: 500 })),
        /try again later/
    );
});
