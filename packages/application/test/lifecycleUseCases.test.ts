import assert from "node:assert/strict";
import test from "node:test";
import {
    BookAccessDeniedError,
    BookLifecycleLockLostError,
    BookLifecycleLockTimeoutError,
    BookLifecycleLockUnavailableError,
    BookNotFoundError,
    BookNotRetryableError,
    BookProcessingBusyError,
    BookProcessingQueueUnavailableError,
    BookProcessingSkippedError,
    type Book,
    type BookProcessingRecord,
} from "@reader/domain";
import {
    DeleteOwnedBook,
    GetBookStatus,
    ListOwnedBooks,
    ProcessUploadedBook,
    RetryBookProcessing,
} from "../src";
import type {
    DeleteOwnedBookDependencies,
    ProcessUploadedBookDependencies,
    RetryBookProcessingDependencies,
} from "../src";

const makeBook = (overrides: Partial<Book> = {}): Book => ({
    id: "book-1",
    title: "Book.pdf",
    userId: "user-1",
    fileKey: "users/user-1/books/book-1/original",
    fileType: "pdf",
    collectionName: "book_collection",
    processingStatus: "failed",
    processingError: "previous error",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
});

const makeProcessingRecord = (
    overrides: Partial<BookProcessingRecord> = {}
): BookProcessingRecord => ({
    id: "book-1",
    userId: "user-1",
    fileKey: "authoritative-file-key",
    fileType: "pdf",
    collectionName: null,
    processingStatus: "processing",
    processingError: null,
    ...overrides,
});

test("ListOwnedBooks delegates to owner-scoped read and preserves rows", async () => {
    const rows = [makeBook(), makeBook({ id: "book-2" })];
    let requestedOwner = "";
    const result = await new ListOwnedBooks({
        repository: {
            listByOwner: async (userId) => {
                requestedOwner = userId;
                return rows;
            },
        },
    }).execute({ userId: "user-1" });
    assert.equal(requestedOwner, "user-1");
    assert.deepEqual(result, { books: rows });
});

test("GetBookStatus preserves the response fields and ready semantics", async () => {
    const result = await new GetBookStatus({
        repository: {
            findById: async () =>
                makeBook({
                    processingStatus: "ready",
                    processingError: null,
                    collectionName: "collection",
                }),
        },
    }).execute({ bookId: "book-1", userId: "user-1" });
    assert.deepEqual(result, {
        bookId: "book-1",
        fileType: "pdf",
        ready: true,
        status: "ready",
        error: null,
    });
});

test("GetBookStatus distinguishes missing and non-owned books", async () => {
    const useCase = (book: Book | null) =>
        new GetBookStatus({ repository: { findById: async () => book } });
    await assert.rejects(
        useCase(null).execute({ bookId: "book-1", userId: "user-1" }),
        BookNotFoundError
    );
    await assert.rejects(
        useCase(makeBook({ userId: "another-user" })).execute({
            bookId: "book-1",
            userId: "user-1",
        }),
        BookAccessDeniedError
    );
});

const retryDependencies = (
    calls: string[],
    overrides: Partial<RetryBookProcessingDependencies> = {}
): RetryBookProcessingDependencies => ({
    reads: {
        findOwned: async () => makeBook(),
    },
    retryState: {
        claimRetry: async (bookId, userId, status) => {
            calls.push(`claim:${bookId}:${userId}:${status}`);
            return makeBook({
                processingStatus: "processing",
                processingError: null,
            });
        },
        restoreRetryable: async (bookId, userId, status, error) => {
            calls.push(`restore:${bookId}:${userId}:${status}:${error}`);
            return true;
        },
    },
    queueState: {
        markQueueFailed: async (bookId, userId, error) => {
            calls.push(`queue-failed:${bookId}:${userId}:${error}`);
            return true;
        },
    },
    queue: {
        retryOrEnqueue: async (request) => {
            calls.push(
                `queue:${request.bookId}:${request.userId}:${request.fileKey}:${request.fileType}`
            );
            return "retried";
        },
        removePending: async () => {},
    },
    lock: {
        withLock: async (bookId, fn) => {
            calls.push(`lock:${bookId}`);
            return fn(new AbortController().signal);
        },
    },
    ...overrides,
});

test("RetryBookProcessing claims atomically and queues authoritative data", async () => {
    const calls: string[] = [];
    const result = await new RetryBookProcessing(
        retryDependencies(calls)
    ).execute({ bookId: "book-1", userId: "user-1" });
    assert.deepEqual(result, { bookId: "book-1", status: "processing" });
    assert.deepEqual(calls, [
        "lock:book-1",
        "claim:book-1:user-1:failed",
        "queue:book-1:user-1:users/user-1/books/book-1/original:pdf",
    ]);
});

test("RetryBookProcessing rejects missing, non-retryable, and lost claims", async () => {
    let missingLockCalled = false;
    const missing = retryDependencies([], {
        reads: { findOwned: async () => null },
        lock: {
            withLock: async () => {
                missingLockCalled = true;
                throw new BookLifecycleLockTimeoutError("book-1");
            },
        },
    });
    await assert.rejects(
        new RetryBookProcessing(missing).execute({
            bookId: "book-1",
            userId: "user-1",
        }),
        BookNotFoundError
    );
    assert.equal(missingLockCalled, false);

    const notRetryable = retryDependencies([], {
        reads: {
            findOwned: async () => makeBook({ processingStatus: "ready" }),
        },
    });
    await assert.rejects(
        new RetryBookProcessing(notRetryable).execute({
            bookId: "book-1",
            userId: "user-1",
        }),
        BookNotRetryableError
    );

    const lostClaim = retryDependencies([], {
        retryState: {
            claimRetry: async () => null,
            restoreRetryable: async () => true,
        },
    });
    await assert.rejects(
        new RetryBookProcessing(lostClaim).execute({
            bookId: "book-1",
            userId: "user-1",
        }),
        BookNotRetryableError
    );
});

test("RetryBookProcessing restores the prior state on pending/active conflicts", async () => {
    const calls: string[] = [];
    const dependencies = retryDependencies(calls, {
        queue: {
            retryOrEnqueue: async () => {
                throw new BookProcessingBusyError("book-1");
            },
            removePending: async () => {},
        },
    });
    await assert.rejects(
        new RetryBookProcessing(dependencies).execute({
            bookId: "book-1",
            userId: "user-1",
        }),
        BookProcessingBusyError
    );
    assert.deepEqual(calls, [
        "lock:book-1",
        "claim:book-1:user-1:failed",
        "restore:book-1:user-1:failed:previous error",
    ]);
});

test("RetryBookProcessing marks queue failure and maps queue errors", async () => {
    const calls: string[] = [];
    const dependencies = retryDependencies(calls, {
        queue: {
            retryOrEnqueue: async () => {
                throw new Error("redis offline");
            },
            removePending: async () => {},
        },
    });
    await assert.rejects(
        new RetryBookProcessing(dependencies).execute({
            bookId: "book-1",
            userId: "user-1",
        }),
        (error: unknown) =>
            error instanceof BookProcessingQueueUnavailableError &&
            error.message === "redis offline"
    );
    assert.equal(calls.at(-1), "queue-failed:book-1:user-1:redis offline");
});

test("RetryBookProcessing maps lock timeout to busy and preserves unavailable", async () => {
    for (const [lockError, expected] of [
        [new BookLifecycleLockTimeoutError("book-1"), BookProcessingBusyError],
        [
            new BookLifecycleLockUnavailableError("book-1"),
            BookLifecycleLockUnavailableError,
        ],
    ] as const) {
        const calls: string[] = [];
        const dependencies = retryDependencies(calls, {
            lock: {
                withLock: async () => {
                    throw lockError;
                },
            },
        });
        await assert.rejects(
            new RetryBookProcessing(dependencies).execute({
                bookId: "book-1",
                userId: "user-1",
            }),
            expected
        );
        assert.deepEqual(calls, []);
    }
});

const deleteDependencies = (
    calls: string[],
    overrides: Partial<DeleteOwnedBookDependencies> = {}
): DeleteOwnedBookDependencies => ({
    reads: {
        findById: async () => makeBook({ processingStatus: "ready" }),
        findOwned: async () => makeBook({ processingStatus: "deleting" }),
    },
    deletion: {
        markDeleting: async (bookId, userId) => {
            calls.push(`mark-deleting:${bookId}:${userId}`);
            return true;
        },
        deleteDeletingRow: async (bookId, userId) => {
            calls.push(`delete-row:${bookId}:${userId}`);
            return true;
        },
    },
    references: {
        countLiveFileReferences: async (key) => {
            calls.push(`file-refs:${key}`);
            return 0;
        },
        countLiveCollectionReferences: async (name) => {
            calls.push(`collection-refs:${name}`);
            return 0;
        },
    },
    cleanup: {
        deleteFile: async (key) => {
            calls.push(`delete-file:${key}`);
        },
        deleteVectorCollection: async (name) => {
            calls.push(`delete-vector:${name}`);
        },
        deleteSearchChunks: async (name) => {
            calls.push(`delete-chunks:${name}`);
        },
        clearCache: (name) => calls.push(`clear-cache:${name}`),
        defaultCollectionName: (bookId) => `default-${bookId}`,
    },
    queue: {
        removePending: async () => {
            calls.push("remove-pending");
        },
    },
    lock: {
        withLock: async (bookId, fn) => {
            calls.push(`lock:${bookId}`);
            return fn(new AbortController().signal);
        },
    },
    ...overrides,
});

test("DeleteOwnedBook persists deleting before ordered artifact cleanup", async () => {
    const calls: string[] = [];
    await new DeleteOwnedBook(deleteDependencies(calls)).execute({
        bookId: "book-1",
        userId: "user-1",
    });
    assert.deepEqual(calls, [
        "mark-deleting:book-1:user-1",
        "remove-pending",
        "lock:book-1",
        "file-refs:users/user-1/books/book-1/original",
        "delete-file:users/user-1/books/book-1/original",
        "collection-refs:book_collection",
        "delete-vector:book_collection",
        "delete-chunks:book_collection",
        "clear-cache:book_collection",
        "delete-row:book-1:user-1",
    ]);
});

test("DeleteOwnedBook conceals missing and distinguishes unauthorized books", async () => {
    const missing = new DeleteOwnedBook(
        deleteDependencies([], {
            reads: {
                findById: async () => null,
                findOwned: async () => null,
            },
        })
    );
    await assert.rejects(
        missing.execute({ bookId: "book-1", userId: "user-1" }),
        BookNotFoundError
    );
    const unauthorized = new DeleteOwnedBook(
        deleteDependencies([], {
            reads: {
                findById: async () => makeBook({ userId: "another-user" }),
                findOwned: async () => null,
            },
        })
    );
    await assert.rejects(
        unauthorized.execute({ bookId: "book-1", userId: "user-1" }),
        BookAccessDeniedError
    );
});

test("DeleteOwnedBook preserves shared artifacts and resumes failed cleanup", async () => {
    const calls: string[] = [];
    let failOnce = true;
    const dependencies = deleteDependencies(calls, {
        references: {
            countLiveFileReferences: async () => 1,
            countLiveCollectionReferences: async () => 1,
        },
        cleanup: {
            deleteFile: async () => {},
            deleteVectorCollection: async () => {},
            deleteSearchChunks: async () => {},
            clearCache: () => {},
            defaultCollectionName: (bookId) => `default-${bookId}`,
        },
        deletion: {
            markDeleting: async () => true,
            deleteDeletingRow: async () => {
                if (failOnce) {
                    failOnce = false;
                    throw new Error("database unavailable");
                }
                calls.push("delete-row");
                return true;
            },
        },
    });
    const useCase = new DeleteOwnedBook(dependencies);
    await assert.rejects(
        useCase.execute({ bookId: "book-1", userId: "user-1" }),
        /database unavailable/
    );
    await useCase.execute({ bookId: "book-1", userId: "user-1" });
    assert.equal(calls.filter((call) => call === "delete-row").length, 1);
    assert.ok(!calls.some((call) => call.startsWith("delete-file:")));
    assert.ok(!calls.some((call) => call.startsWith("delete-vector:")));
});

test("DeleteOwnedBook stops cleanup and never deletes the row after lock loss", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const lockLost = new BookLifecycleLockLostError("book-1");
    const dependencies = deleteDependencies(calls, {
        lock: {
            withLock: async (_bookId, fn) => fn(controller.signal),
        },
        cleanup: {
            deleteFile: async () => {
                calls.push("delete-file");
                controller.abort(lockLost);
            },
            deleteVectorCollection: async () => {
                calls.push("delete-vector");
            },
            deleteSearchChunks: async () => {
                calls.push("delete-chunks");
            },
            clearCache: () => calls.push("clear-cache"),
            defaultCollectionName: (bookId) => `default-${bookId}`,
        },
    });

    await assert.rejects(
        new DeleteOwnedBook(dependencies).execute({
            bookId: "book-1",
            userId: "user-1",
        }),
        (error: unknown) => error === lockLost
    );
    assert.ok(!calls.includes("delete-row:book-1:user-1"));
    assert.ok(!calls.includes("delete-vector"));
    assert.ok(!calls.includes("delete-chunks"));
});

test("ProcessUploadedBook skips replays and ingests the stored file key", async () => {
    for (const [status, reason] of [
        ["ready", "ready"],
        ["deleting", "deleting"],
        ["failed", "not_processing"],
    ] as const) {
        const calls: string[] = [];
        const dependencies: ProcessUploadedBookDependencies = {
            repository: {
                findBookForProcessing: async () =>
                    makeProcessingRecord({ processingStatus: status }),
                markReady: async () => true,
                markFailed: async () => true,
            },
            ingestion: {
                ingest: async () => {
                    calls.push("ingest");
                    return {
                        collectionName: "collection",
                        chunks: 0,
                        reusedCollection: false,
                    };
                },
            },
            cleanup: { deleteCollection: async () => {} },
            references: {
                countLiveFileReferences: async () => 0,
                countLiveCollectionReferences: async () => 0,
            },
            lock: {
                withLock: async (_bookId, fn) =>
                    fn(new AbortController().signal),
            },
            cache: { clearCollection: () => {} },
        };
        await assert.rejects(
            new ProcessUploadedBook(dependencies).execute({
                bookId: "book-1",
                userId: "user-1",
                fileKey: "queued-key-must-not-be-used",
                fileType: "pdf",
            }),
            (error: unknown) =>
                error instanceof BookProcessingSkippedError &&
                error.reason === reason
        );
        assert.deepEqual(calls, []);
    }

    let ingestedFileKey = "";
    const dependencies: ProcessUploadedBookDependencies = {
        repository: {
            findBookForProcessing: async () => makeProcessingRecord(),
            markReady: async () => true,
            markFailed: async () => true,
        },
        ingestion: {
            ingest: async (input) => {
                ingestedFileKey = input.fileKey;
                return {
                    collectionName: "collection",
                    chunks: 1,
                    reusedCollection: false,
                };
            },
        },
        cleanup: { deleteCollection: async () => {} },
        references: {
            countLiveFileReferences: async () => 0,
            countLiveCollectionReferences: async () => 0,
        },
        lock: {
            withLock: async (_bookId, fn) => fn(new AbortController().signal),
        },
        cache: { clearCollection: () => {} },
    };
    await new ProcessUploadedBook(dependencies).execute({
        bookId: "book-1",
        userId: "user-1",
        fileKey: "queued-key-must-not-be-used",
        fileType: "pdf",
    });
    assert.equal(ingestedFileKey, "authoritative-file-key");
});

test("ProcessUploadedBook preserves shared collections on rejected publication", async () => {
    const calls: string[] = [];
    const dependencies: ProcessUploadedBookDependencies = {
        repository: {
            findBookForProcessing: async () => makeProcessingRecord(),
            markReady: async () => false,
            markFailed: async () => {
                calls.push("mark-failed");
                return true;
            },
        },
        ingestion: {
            ingest: async () => ({
                collectionName: "shared",
                chunks: 1,
                reusedCollection: false,
            }),
        },
        cleanup: {
            deleteCollection: async () => {
                calls.push("delete-collection");
            },
        },
        references: {
            countLiveFileReferences: async () => 0,
            countLiveCollectionReferences: async () => 1,
        },
        lock: {
            withLock: async (_bookId, fn) => fn(new AbortController().signal),
        },
        cache: { clearCollection: () => calls.push("clear-cache") },
    };
    await assert.rejects(
        new ProcessUploadedBook(dependencies).execute({
            bookId: "book-1",
            userId: "user-1",
            fileKey: "queued-key",
            fileType: "pdf",
        }),
        BookProcessingSkippedError
    );
    assert.deepEqual(calls, []);
});

test("ProcessUploadedBook lock failures do not write lifecycle state", async () => {
    const calls: string[] = [];
    const dependencies: ProcessUploadedBookDependencies = {
        repository: {
            findBookForProcessing: async () => {
                calls.push("find");
                return makeProcessingRecord();
            },
            markReady: async () => true,
            markFailed: async () => {
                calls.push("mark-failed");
                return true;
            },
        },
        ingestion: { ingest: async () => assert.fail("must not ingest") },
        cleanup: { deleteCollection: async () => {} },
        references: {
            countLiveFileReferences: async () => 0,
            countLiveCollectionReferences: async () => 0,
        },
        lock: {
            withLock: async () => {
                throw new BookLifecycleLockUnavailableError("book-1");
            },
        },
        cache: { clearCollection: () => {} },
    };
    await assert.rejects(
        new ProcessUploadedBook(dependencies).execute({
            bookId: "book-1",
            userId: "user-1",
            fileKey: "key",
            fileType: "pdf",
        }),
        BookLifecycleLockUnavailableError
    );
    assert.deepEqual(calls, []);
});

test("ProcessUploadedBook propagates lock loss during ingestion without publishing failure", async () => {
    let signalIngestionStarted!: () => void;
    const ingestionStarted = new Promise<void>((resolve) => {
        signalIngestionStarted = resolve;
    });
    let releaseIngestion!: () => void;
    const ingestionGate = new Promise<void>((resolve) => {
        releaseIngestion = resolve;
    });
    const controller = new AbortController();
    const lockLost = new BookLifecycleLockLostError("book-1");
    const calls: string[] = [];
    const dependencies: ProcessUploadedBookDependencies = {
        repository: {
            findBookForProcessing: async () => makeProcessingRecord(),
            markReady: async () => {
                calls.push("mark-ready");
                return true;
            },
            markFailed: async () => {
                calls.push("mark-failed");
                return true;
            },
        },
        ingestion: {
            ingest: async () => {
                calls.push("ingest");
                signalIngestionStarted();
                await ingestionGate;
                return {
                    collectionName: "collection",
                    chunks: 1,
                    reusedCollection: false,
                };
            },
        },
        cleanup: {
            deleteCollection: async () => {
                calls.push("delete");
            },
        },
        references: {
            countLiveFileReferences: async () => 0,
            countLiveCollectionReferences: async () => 0,
        },
        lock: {
            withLock: async (_bookId, fn) => fn(controller.signal),
        },
        cache: { clearCollection: () => {} },
    };

    const processing = new ProcessUploadedBook(dependencies).execute({
        bookId: "book-1",
        userId: "user-1",
        fileKey: "key",
        fileType: "pdf",
    });
    await ingestionStarted;
    controller.abort(lockLost);
    releaseIngestion();

    await assert.rejects(processing, (error: unknown) => error === lockLost);
    assert.deepEqual(calls, ["ingest"]);
});
