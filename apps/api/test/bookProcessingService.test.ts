import assert from "node:assert/strict";
import test from "node:test";
import type { BookProcessingRepository } from "../src/services/BookProcessingService";
import { handleProcessUploadedBook } from "../src/services/BookProcessingService";
import type { BookFileType } from "@reader/processing";

const payload = {
    bookId: "book-1",
    userId: "user-1",
    fileKey: "epub-key",
    fileType: "epub" as BookFileType,
};

const createRepository = (
    overrides: Partial<BookProcessingRepository> = {}
) => {
    const calls = {
        ready: [] as string[],
        failed: [] as string[],
    };
    const repository: BookProcessingRepository = {
        findBookForProcessing: async () => ({
            id: "book-1",
            userId: "user-1",
            fileKey: "epub-key",
            fileType: "epub",
            collectionName: null,
            processingStatus: "processing",
            processingError: null,
        }),
        markReady: async (_, _userId, collectionName) => {
            calls.ready.push(collectionName);
            return true;
        },
        markFailed: async (_, _userId, error) => {
            calls.failed.push(error);
            return true;
        },
        ...overrides,
    };

    return { repository, calls };
};

const testLifecycle = {
    lock: {
        withLock: async <T>(
            _bookId: string,
            fn: (signal: AbortSignal) => Promise<T>
        ) => fn(new AbortController().signal),
    },
    cleanup: {
        defaultCollectionName: (bookId: string) => `book_${bookId}`,
        attemptCollectionName: (bookId: string, attemptId: string) =>
            `book_${bookId}_${attemptId}`,
        deleteCollection: async () => {},
    },
    attemptIds: { next: () => "a1b2c3d4" },
    references: {
        countLiveFileReferences: async () => 0,
        countLiveCollectionReferences: async () => 0,
    },
};

test("successful synchronous processing marks book ready", async () => {
    const { repository, calls } = createRepository();

    const result = await handleProcessUploadedBook(
        payload,
        repository,
        async (input) => ({
            collectionName: input.collectionName!,
            chunks: 2,
            reusedCollection: false,
        }),
        {},
        testLifecycle
    );

    assert.equal(result.collectionName, "book_book-1_a1b2c3d4");
    assert.deepEqual(calls.ready, ["book_book-1_a1b2c3d4"]);
    assert.deepEqual(calls.failed, []);
});

test("failed synchronous processing marks book failed", async () => {
    const { repository, calls } = createRepository();

    await assert.rejects(
        handleProcessUploadedBook(
            payload,
            repository,
            async () => {
                throw new Error("extract failed");
            },
            {},
            testLifecycle
        ),
        /extract failed/
    );

    assert.deepEqual(calls.ready, []);
    assert.deepEqual(calls.failed, ["extract failed"]);
});

test("failed processing can skip failed status for retryable attempts", async () => {
    const { repository, calls } = createRepository();

    await assert.rejects(
        handleProcessUploadedBook(
            payload,
            repository,
            async () => {
                throw new Error("temporary embedding failure");
            },
            { markFailedOnError: false },
            testLifecycle
        ),
        /temporary embedding failure/
    );

    assert.deepEqual(calls.ready, []);
    assert.deepEqual(calls.failed, []);
});

test("failed processing marks failed on final attempt option", async () => {
    const { repository, calls } = createRepository();

    await assert.rejects(
        handleProcessUploadedBook(
            payload,
            repository,
            async () => {
                throw new Error("final embedding failure");
            },
            { markFailedOnError: true },
            testLifecycle
        ),
        /final embedding failure/
    );

    assert.deepEqual(calls.ready, []);
    assert.deepEqual(calls.failed, ["final embedding failure"]);
});

test("same file key does not trigger duplicate collection reuse", async () => {
    const { repository, calls } = createRepository({
        findBookForProcessing: async () => ({
            id: "book-1",
            userId: "user-1",
            fileKey: "epub-same-metadata",
            fileType: "epub",
            collectionName: null,
            processingStatus: "processing",
            processingError: null,
        }),
    });
    let seenBookId: string | undefined;
    let seenFileKey: string | undefined;

    const result = await handleProcessUploadedBook(
        { ...payload, fileKey: "epub-same-metadata" },
        repository,
        async (input) => {
            seenBookId = input.bookId;
            seenFileKey = input.fileKey;
            return {
                collectionName: input.collectionName!,
                chunks: 2,
                reusedCollection: false,
            };
        },
        {},
        testLifecycle
    );

    assert.equal(seenBookId, "book-1");
    assert.equal(seenFileKey, "epub-same-metadata");
    assert.equal(result.reusedCollection, false);
    assert.deepEqual(calls.ready, ["book_book-1_a1b2c3d4"]);
});

test("file type mismatch fails safely", async () => {
    const { repository, calls } = createRepository({
        findBookForProcessing: async () => ({
            id: "book-1",
            userId: "user-1",
            fileKey: "epub-key",
            fileType: "pdf",
            collectionName: null,
            processingStatus: "processing",
            processingError: null,
        }),
    });

    await assert.rejects(
        handleProcessUploadedBook(
            payload,
            repository,
            async () => ({
                collectionName: "unexpected",
                chunks: 1,
                reusedCollection: false,
            }),
            {},
            testLifecycle
        ),
        /file type changed/
    );

    assert.deepEqual(calls.ready, []);
    assert.equal(calls.failed.length, 1);
});
