import assert from "node:assert/strict";
import test from "node:test";
import { BookNotFoundError, ProgressValidationError } from "@reader/domain";
import { GetReadingProgress, SaveReadingProgress } from "../src";
import type { ReadingProgress } from "@reader/domain";

const row: ReadingProgress = {
    userId: "user-1",
    bookId: "book-1",
    progressPosition: "p1",
    progressChapter: "chapter-1",
    lastReadAt: new Date("2024-01-01T00:00:00.000Z"),
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
};

const clockNow = new Date("2025-02-03T04:05:06.000Z");

test("GetReadingProgress authorizes ownership before returning an empty row", async () => {
    const calls: unknown[] = [];
    const result = await new GetReadingProgress({
        books: {
            findOwned: async (input) => {
                calls.push(["book", input]);
                return {
                    id: "book-1",
                    userId: "user-1",
                    collectionName: null,
                    processingStatus: "deleting",
                };
            },
        },
        progress: {
            find: async (input) => {
                calls.push(["progress", input]);
                return null;
            },
        },
    }).execute({ userId: "user-1", bookId: "book-1" });

    assert.equal(result, null);
    assert.deepEqual(calls, [
        ["book", { userId: "user-1", bookId: "book-1" }],
        ["progress", { userId: "user-1", bookId: "book-1" }],
    ]);
});

test("GetReadingProgress maps a missing or foreign book to not found", async () => {
    let progressReads = 0;
    await assert.rejects(
        new GetReadingProgress({
            books: { findOwned: async () => null },
            progress: {
                find: async () => {
                    progressReads += 1;
                    return row;
                },
            },
        }).execute({ userId: "user-1", bookId: "foreign-book" }),
        BookNotFoundError
    );
    assert.equal(progressReads, 0);
});

test("GetReadingProgress propagates repository failures", async () => {
    const failure = new Error("lookup failed");
    await assert.rejects(
        new GetReadingProgress({
            books: {
                findOwned: async () => {
                    throw failure;
                },
            },
            progress: { find: async () => row },
        }).execute({ userId: "user-1", bookId: "book-1" }),
        failure
    );
});

test("SaveReadingProgress validates before clock and repository access", async () => {
    const calls: string[] = [];
    const save = new SaveReadingProgress({
        repository: {
            saveForLiveOwnedBook: async () => {
                calls.push("save");
                return row;
            },
        },
        clock: {
            now: () => {
                calls.push("clock");
                return clockNow;
            },
        },
    });

    await assert.rejects(
        save.execute({
            userId: "user-1",
            bookId: "book-1",
            position: 42,
            chapter: null,
        }),
        ProgressValidationError
    );
    assert.deepEqual(calls, []);
});

test("SaveReadingProgress passes controlled time and preserves chapter omission", async () => {
    const calls: unknown[] = [];
    const result = await new SaveReadingProgress({
        repository: {
            saveForLiveOwnedBook: async (input) => {
                calls.push(input);
                return row;
            },
        },
        clock: { now: () => clockNow },
    }).execute({
        userId: "user-1",
        bookId: "book-1",
        position: "  p1  ",
    });

    assert.equal(result, row);
    assert.deepEqual(calls, [
        {
            userId: "user-1",
            bookId: "book-1",
            position: "  p1  ",
            chapter: undefined,
            now: clockNow,
        },
    ]);
});

test("SaveReadingProgress distinguishes omitted chapter from explicit null", async () => {
    const inputs: unknown[] = [];
    const save = new SaveReadingProgress({
        repository: {
            saveForLiveOwnedBook: async (input) => {
                inputs.push(input);
                return row;
            },
        },
        clock: { now: () => clockNow },
    });

    await save.execute({
        userId: "user-1",
        bookId: "book-1",
        position: "p1",
    });
    await save.execute({
        userId: "user-1",
        bookId: "book-1",
        position: "p2",
        chapter: null,
    });
    assert.equal((inputs[0] as { chapter: unknown }).chapter, undefined);
    assert.equal((inputs[1] as { chapter: unknown }).chapter, null);
});

test("SaveReadingProgress maps a missing or deleting book to not found", async () => {
    await assert.rejects(
        new SaveReadingProgress({
            repository: { saveForLiveOwnedBook: async () => null },
            clock: { now: () => clockNow },
        }).execute({
            userId: "user-1",
            bookId: "book-1",
            position: "p1",
        }),
        BookNotFoundError
    );
});

test("SaveReadingProgress propagates repository errors", async () => {
    const failure = new Error("database unavailable");
    await assert.rejects(
        new SaveReadingProgress({
            repository: {
                saveForLiveOwnedBook: async () => {
                    throw failure;
                },
            },
            clock: { now: () => clockNow },
        }).execute({
            userId: "user-1",
            bookId: "book-1",
            position: "p1",
        }),
        failure
    );
});
