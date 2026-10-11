import assert from "node:assert/strict";
import test from "node:test";
import {
    BookDeletedDuringProcessingError,
    BookFileTypeMismatchError,
    BookNotFoundError,
    BookProcessingQueueUnavailableError,
    InvalidBookFileError,
    MissingBookFileError,
    type Book,
    type BookProcessingRecord,
    type BookProcessingRequest,
} from "@reader/domain";
import { EnqueueBookProcessing, ProcessUploadedBook, UploadBook } from "../src";
import type {
    EnqueueBookProcessingDependencies,
    ProcessUploadedBookDependencies,
    UploadBookDependencies,
} from "../src";

const book: Book = {
    id: "book-1",
    title: "Book.pdf",
    userId: "user-1",
    fileKey: "users/user-1/books/book-1/original",
    fileType: "pdf",
    collectionName: null,
    processingStatus: "processing",
    processingError: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
};

const request: BookProcessingRequest = {
    bookId: book.id,
    userId: book.userId,
    fileKey: book.fileKey,
    fileType: "pdf",
};

const uploadDeps = (
    calls: string[],
    overrides: Partial<UploadBookDependencies> = {}
): UploadBookDependencies => ({
    ids: { next: () => "book-1" },
    validator: {
        detectFileType: async () => {
            calls.push("validate");
            return "pdf";
        },
    },
    storage: {
        save: async (key) => {
            calls.push(`save:${key}`);
        },
    },
    books: {
        create: async (newBook) => {
            calls.push("create");
            return { ...book, ...newBook };
        },
        findById: async () => {
            calls.push("findById");
            return { ...book, processingStatus: "queue_failed" };
        },
    },
    scheduler: {
        schedule: async () => {
            calls.push("schedule");
        },
    },
    ...overrides,
});

test("UploadBook rejects a missing file without side effects", async () => {
    const calls: string[] = [];
    await assert.rejects(
        new UploadBook(uploadDeps(calls)).execute({ userId: "user-1" }),
        MissingBookFileError
    );
    assert.deepEqual(calls, []);
});

test("UploadBook rejects invalid input without writes", async () => {
    const calls: string[] = [];
    const deps = uploadDeps(calls, {
        validator: {
            detectFileType: async () => {
                calls.push("validate");
                throw new Error("bad signature");
            },
        },
    });
    await assert.rejects(
        new UploadBook(deps).execute({
            userId: "user-1",
            file: { originalName: "bad", buffer: new Uint8Array() },
        }),
        (error: unknown) =>
            error instanceof InvalidBookFileError &&
            error.message === "bad signature"
    );
    assert.deepEqual(calls, ["validate"]);
});

for (const fileType of ["pdf", "epub"] as const) {
    test(`UploadBook schedules accepted ${fileType} in order and refetches`, async () => {
        const calls: string[] = [];
        const deps = uploadDeps(calls, {
            validator: {
                detectFileType: async () => {
                    calls.push("validate");
                    return fileType;
                },
            },
        });
        const result = await new UploadBook(deps).execute({
            userId: "user-1",
            file: {
                originalName: `Book.${fileType}`,
                buffer: new Uint8Array(),
            },
        });
        assert.deepEqual(calls, [
            "validate",
            "save:users/user-1/books/book-1/original",
            "create",
            "schedule",
            "findById",
        ]);
        assert.equal(result.fileType, fileType);
        assert.equal(
            result.mimeType,
            fileType === "pdf" ? "application/pdf" : "application/epub+zip"
        );
        assert.equal(result.book.processingStatus, "queue_failed");
    });
}

test("UploadBook falls back to the created book after a null refetch", async () => {
    const calls: string[] = [];
    const result = await new UploadBook(
        uploadDeps(calls, {
            books: {
                create: async (newBook) => ({ ...book, ...newBook }),
                findById: async () => null,
            },
        })
    ).execute({
        userId: "user-1",
        file: { originalName: "Book.pdf", buffer: new Uint8Array() },
    });
    assert.equal(result.book.id, "book-1");
});

test("UploadBook wraps scheduler failures and does not refetch", async () => {
    const calls: string[] = [];
    const deps = uploadDeps(calls, {
        scheduler: {
            schedule: async () => {
                calls.push("schedule");
                throw new Error("queue offline");
            },
        },
    });
    await assert.rejects(
        new UploadBook(deps).execute({
            userId: "user-1",
            file: { originalName: "Book.pdf", buffer: new Uint8Array() },
        }),
        (error: unknown) =>
            error instanceof BookProcessingQueueUnavailableError &&
            error.message === "queue offline"
    );
    assert.deepEqual(calls.slice(-2), ["create", "schedule"]);
});

test("UploadBook propagates storage failure and does not create a book", async () => {
    const calls: string[] = [];
    const deps = uploadDeps(calls, {
        storage: {
            save: async () => {
                calls.push("save");
                throw new Error("storage failed");
            },
        },
    });
    await assert.rejects(
        new UploadBook(deps).execute({
            userId: "user-1",
            file: { originalName: "Book.pdf", buffer: new Uint8Array() },
        }),
        /storage failed/
    );
    assert.deepEqual(calls, ["validate", "save"]);
});

const enqueueDeps = (
    calls: string[],
    overrides: Partial<EnqueueBookProcessingDependencies> = {}
): EnqueueBookProcessingDependencies => ({
    queue: {
        enqueue: async () => {
            calls.push("enqueue");
        },
    },
    repository: {
        markQueueFailed: async (id, error) => {
            calls.push(`failed:${id}:${error}`);
        },
    },
    ...overrides,
});

test("EnqueueBookProcessing enqueues successfully", async () => {
    const calls: string[] = [];
    await new EnqueueBookProcessing(enqueueDeps(calls)).execute(request);
    assert.deepEqual(calls, ["enqueue"]);
});

for (const [thrown, expected] of [
    [new Error("queue offline"), "queue offline"],
    ["non-error", "Unknown error"],
] as const) {
    test(`EnqueueBookProcessing marks failed for ${expected}`, async () => {
        const calls: string[] = [];
        const deps = enqueueDeps(calls, {
            queue: {
                enqueue: async () => {
                    throw thrown;
                },
            },
        });
        await assert.rejects(
            new EnqueueBookProcessing(deps).execute(request),
            (error: unknown) =>
                error instanceof BookProcessingQueueUnavailableError &&
                error.message === expected
        );
        assert.deepEqual(calls, [`failed:book-1:${expected}`]);
    });
}

const processingRecord: BookProcessingRecord = {
    id: book.id,
    userId: book.userId,
    fileKey: book.fileKey,
    fileType: "pdf",
    collectionName: null,
    processingStatus: "processing",
    processingError: null,
};

const ingestionResult = {
    collectionName: "book_collection",
    chunks: 3,
    reusedCollection: false,
};

const processDeps = (
    calls: string[],
    overrides: Partial<ProcessUploadedBookDependencies> = {}
): ProcessUploadedBookDependencies => ({
    repository: {
        findBookForProcessing: async () => {
            calls.push("find");
            return processingRecord;
        },
        markReady: async () => {
            calls.push("ready");
            return true;
        },
        markFailed: async (_id, error) => {
            calls.push(`failed:${error}`);
        },
    },
    ingestion: {
        ingest: async () => {
            calls.push("ingest");
            return ingestionResult;
        },
    },
    cleanup: {
        deleteCollection: async (name) => {
            calls.push(`cleanup:${name}`);
        },
    },
    cache: {
        clearCollection: (name) => calls.push(`cache:${name}`),
    },
    ...overrides,
});

for (const fileType of ["pdf", "epub"] as const) {
    test(`ProcessUploadedBook publishes ${fileType} and clears cache`, async () => {
        const calls: string[] = [];
        const result = await new ProcessUploadedBook(
            processDeps(calls, {
                repository: {
                    findBookForProcessing: async () => ({
                        ...processingRecord,
                        fileType,
                    }),
                    markReady: async () => {
                        calls.push("ready");
                        return true;
                    },
                    markFailed: async () => {},
                },
            })
        ).execute({ ...request, fileType });
        assert.deepEqual(result, ingestionResult);
        assert.deepEqual(calls, ["ingest", "ready", "cache:book_collection"]);
    });
}

test("ProcessUploadedBook marks a missing book failed", async () => {
    const calls: string[] = [];
    await assert.rejects(
        new ProcessUploadedBook(
            processDeps(calls, {
                repository: {
                    findBookForProcessing: async () => null,
                    markReady: async () => true,
                    markFailed: async (_id, error) => {
                        calls.push(`failed:${error}`);
                    },
                },
            })
        ).execute(request),
        BookNotFoundError
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^failed:Book book-1 was not found$/);
});

test("ProcessUploadedBook rejects a file type mismatch", async () => {
    const calls: string[] = [];
    await assert.rejects(
        new ProcessUploadedBook(
            processDeps(calls, {
                repository: {
                    findBookForProcessing: async () => ({
                        ...processingRecord,
                        fileType: "epub",
                    }),
                    markReady: async () => true,
                    markFailed: async (_id, error) => {
                        calls.push(`failed:${error}`);
                    },
                },
            })
        ).execute(request),
        BookFileTypeMismatchError
    );
    assert.deepEqual(calls, [
        "failed:Book book-1 file type changed from pdf to epub",
    ]);
});

test("ProcessUploadedBook can skip marking retryable errors", async () => {
    const calls: string[] = [];
    await assert.rejects(
        new ProcessUploadedBook(
            processDeps(calls, {
                ingestion: {
                    ingest: async () => {
                        calls.push("ingest");
                        throw new Error("temporary");
                    },
                },
            })
        ).execute(request, { markFailedOnError: false }),
        /temporary/
    );
    assert.deepEqual(calls, ["find", "ingest"]);
});

test("ProcessUploadedBook marks final-attempt errors failed", async () => {
    const calls: string[] = [];
    await assert.rejects(
        new ProcessUploadedBook(
            processDeps(calls, {
                ingestion: {
                    ingest: async () => {
                        calls.push("ingest");
                        throw new Error("permanent");
                    },
                },
            })
        ).execute(request, { markFailedOnError: true }),
        /permanent/
    );
    assert.deepEqual(calls, ["find", "ingest", "failed:permanent"]);
});

test("ProcessUploadedBook cleans rejected publication and persists its error", async () => {
    const calls: string[] = [];
    await assert.rejects(
        new ProcessUploadedBook(
            processDeps(calls, {
                repository: {
                    findBookForProcessing: async () => {
                        calls.push("find");
                        return processingRecord;
                    },
                    markReady: async () => false,
                    markFailed: async (_id, error) => {
                        calls.push(`failed:${error}`);
                    },
                },
            })
        ).execute(request),
        BookDeletedDuringProcessingError
    );
    assert.deepEqual(calls, [
        "find",
        "ingest",
        "cleanup:book_collection",
        "failed:Book book-1 was deleted during processing",
    ]);
});

test("ProcessUploadedBook marks ingestion errors failed", async () => {
    const calls: string[] = [];
    await assert.rejects(
        new ProcessUploadedBook(
            processDeps(calls, {
                ingestion: {
                    ingest: async () => {
                        calls.push("ingest");
                        throw new Error("ingestion failed");
                    },
                },
            })
        ).execute(request),
        /ingestion failed/
    );
    assert.deepEqual(calls, ["find", "ingest", "failed:ingestion failed"]);
});
