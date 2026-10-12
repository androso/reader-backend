import assert from "node:assert/strict";
import test from "node:test";
import {
    BookAccessDeniedError,
    BookNotFoundError,
    type Book,
} from "@reader/domain";
import { GetOwnedBookFile } from "../src/books/GetOwnedBookFile";

const book = {
    id: "book-1",
    userId: "user-1",
    fileKey: "original.pdf",
    fileType: "pdf",
} satisfies Pick<Book, "id" | "userId" | "fileKey" | "fileType">;

test("GetOwnedBookFile reads the original file for its owner", async () => {
    const calls: string[] = [];
    const bytes = new Uint8Array([1, 2, 3]);
    const useCase = new GetOwnedBookFile({
        books: { findById: async () => book },
        storage: {
            getFile: async (fileKey) => {
                calls.push(fileKey);
                return bytes;
            },
        },
    });

    assert.deepEqual(
        await useCase.execute({ bookId: "book-1", userId: "user-1" }),
        { bytes, fileType: "pdf" }
    );
    assert.deepEqual(calls, ["original.pdf"]);
});

test("GetOwnedBookFile preserves missing and foreign-book errors", async () => {
    let storageReads = 0;
    const useCase = new GetOwnedBookFile({
        books: {
            findById: async (bookId) => (bookId === "book-1" ? book : null),
        },
        storage: {
            getFile: async () => {
                storageReads += 1;
                return new Uint8Array();
            },
        },
    });

    await assert.rejects(
        useCase.execute({ bookId: "missing", userId: "user-1" }),
        BookNotFoundError
    );
    await assert.rejects(
        useCase.execute({ bookId: "book-1", userId: "user-2" }),
        BookAccessDeniedError
    );
    assert.equal(storageReads, 0);
});
