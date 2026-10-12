import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
    BookLifecycleLockLostError,
    BookLifecycleLockTimeoutError,
    BookLifecycleLockUnavailableError,
    BookProcessingBusyError,
} from "@reader/domain";
import { createBookArtifactCleanup } from "../src/infrastructure/books/bookArtifactCleanup";
import { createBullMqBookQueueControl } from "../src/infrastructure/books/bullmqBookQueueControl";
import { createPostgresBookLifecycleLock } from "../src/infrastructure/books/postgresBookLifecycleLock";

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

const request = {
    bookId: "book-1",
    userId: "user-1",
    fileKey: "file-1",
    fileType: "pdf" as const,
};

test("BullMQ control retries retained terminal jobs with both attempt resets", async () => {
    for (const state of ["failed", "completed"] as const) {
        const calls: unknown[][] = [];
        const queueControl = createBullMqBookQueueControl({
            queue: {
                getJob: async (id) => {
                    calls.push(["getJob", id]);
                    return {
                        getState: async () => state,
                        retry: async (...args) => {
                            calls.push(["retry", ...args]);
                        },
                        remove: async () => {
                            calls.push(["remove"]);
                        },
                    };
                },
            },
            enqueue: async () => {
                calls.push(["enqueue"]);
            },
        });

        assert.equal(await queueControl.retryOrEnqueue(request), "retried");
        assert.deepEqual(calls, [
            ["getJob", "book-processing-book-1"],
            [
                "retry",
                state,
                {
                    resetAttemptsMade: true,
                    resetAttemptsStarted: true,
                },
            ],
        ]);
    }
});

test("BullMQ control enqueues missing and unknown jobs and reports busy states", async () => {
    const enqueued: unknown[] = [];
    const missing = createBullMqBookQueueControl({
        queue: { getJob: async () => undefined },
        enqueue: async (value) => {
            enqueued.push(value);
        },
    });
    assert.equal(await missing.retryOrEnqueue(request), "enqueued");

    const unknown = createBullMqBookQueueControl({
        queue: {
            getJob: async () => ({
                getState: async () => "unknown",
                retry: async () => {},
                remove: async () => {},
            }),
        },
        enqueue: async (value) => {
            enqueued.push(value);
        },
    });
    assert.equal(await unknown.retryOrEnqueue(request), "enqueued");
    assert.deepEqual(enqueued, [request, request]);

    for (const state of [
        "active",
        "waiting",
        "delayed",
        "prioritized",
        "waiting-children",
    ]) {
        const busy = createBullMqBookQueueControl({
            queue: {
                getJob: async () => ({
                    getState: async () => state,
                    retry: async () => {},
                    remove: async () => {},
                }),
            },
        });
        await assert.rejects(
            busy.retryOrEnqueue(request),
            BookProcessingBusyError
        );
    }
});

test("BullMQ removes only waiting, delayed, and prioritized jobs", async () => {
    const removed: string[] = [];
    const queueControl = createBullMqBookQueueControl({
        queue: {
            getJob: async (id) => ({
                getState: async () =>
                    id.endsWith("1")
                        ? "waiting"
                        : id.endsWith("2")
                          ? "delayed"
                          : id.endsWith("3")
                            ? "prioritized"
                            : "active",
                retry: async () => {},
                remove: async () => {
                    removed.push(id);
                },
            }),
        },
    });

    await queueControl.removePending("1");
    await queueControl.removePending("2");
    await queueControl.removePending("3");
    await queueControl.removePending("4");
    assert.deepEqual(removed, [
        "book-processing-1",
        "book-processing-2",
        "book-processing-3",
    ]);
});

test("PostgreSQL lifecycle lock unlocks, resets timeout, and releases after success or callback failure", async () => {
    const queries: Array<[string, unknown[] | undefined]> = [];
    const releases: unknown[] = [];
    const lock = createPostgresBookLifecycleLock({
        pool: {
            connect: async () =>
                ({
                    query: async (sql: string, params?: unknown[]) => {
                        queries.push([sql, params]);
                        return sql.includes("pg_advisory_unlock")
                            ? { rows: [{ unlocked: true }] }
                            : { rows: [] };
                    },
                    on: () => undefined,
                    removeListener: () => undefined,
                    release: (error?: unknown) => releases.push(error),
                }) as never,
        },
    });

    assert.equal(await lock.withLock("book-1", async () => "result"), "result");
    await assert.rejects(
        lock.withLock("book-2", async () => {
            throw new Error("callback failed");
        }),
        /callback failed/
    );
    assert.equal(queries.length, 8);
    assert.match(queries[1][0], /pg_advisory_lock/);
    assert.match(queries[2][0], /pg_advisory_unlock/);
    assert.equal(queries[3][0], "RESET lock_timeout");
    assert.equal(releases.length, 2);
    assert.deepEqual(releases, [undefined, undefined]);
});

test("PostgreSQL lifecycle lock maps contention and retires failed coordination clients", async () => {
    const released: unknown[] = [];
    const timeoutError = Object.assign(new Error("lock timeout"), {
        code: "55P03",
    });
    const timeoutLock = createPostgresBookLifecycleLock({
        pool: {
            connect: async () =>
                ({
                    query: async (sql: string) => {
                        if (sql.includes("pg_advisory_lock")) {
                            throw timeoutError;
                        }
                        return { rows: [] };
                    },
                    on: () => undefined,
                    removeListener: () => undefined,
                    release: (error?: unknown) => released.push(error),
                }) as never,
        },
    });
    await assert.rejects(
        timeoutLock.withLock("book-1", async () => "unreachable"),
        BookLifecycleLockTimeoutError
    );
    assert.equal(released.length, 1);
    assert.ok(released[0] instanceof Error);

    const unavailableLock = createPostgresBookLifecycleLock({
        pool: {
            connect: async () =>
                ({
                    query: async (sql: string) => {
                        if (sql.includes("pg_advisory_lock")) {
                            throw new Error("connection lost");
                        }
                        return { rows: [] };
                    },
                    on: () => undefined,
                    removeListener: () => undefined,
                    release: (error?: unknown) => released.push(error),
                }) as never,
        },
    });
    await assert.rejects(
        unavailableLock.withLock("book-2", async () => "unreachable"),
        BookLifecycleLockUnavailableError
    );
    assert.equal(released.length, 2);
});

test("PostgreSQL lifecycle lock retires a client when advisory unlock fails", async () => {
    const queries: string[] = [];
    let releasedWith: unknown;
    const lock = createPostgresBookLifecycleLock({
        pool: {
            connect: async () =>
                ({
                    query: async (sql: string) => {
                        queries.push(sql);
                        return sql.includes("pg_advisory_unlock")
                            ? { rows: [{ unlocked: false }] }
                            : { rows: [] };
                    },
                    on: () => undefined,
                    removeListener: () => undefined,
                    release: (error?: unknown) => {
                        releasedWith = error;
                    },
                }) as never,
        },
    });

    await assert.rejects(
        lock.withLock("book-1", async () => "result"),
        BookLifecycleLockUnavailableError
    );
    assert.equal(queries.length, 3);
    assert.match(queries[2], /pg_advisory_unlock/);
    assert.ok(releasedWith instanceof Error);
});

test("PostgreSQL lifecycle lock semaphore prevents nested pool starvation", async () => {
    let checkedOut = 0;
    let peakCheckedOut = 0;
    const connectWaiters: Array<() => void> = [];
    const fakePool = {
        options: { max: 4 },
        connect: async () => {
            if (checkedOut >= 4) {
                await new Promise<void>((resolve) => {
                    connectWaiters.push(resolve);
                });
            }
            checkedOut += 1;
            peakCheckedOut = Math.max(peakCheckedOut, checkedOut);
            const client = new EventEmitter() as EventEmitter & {
                query: (sql: string) => Promise<{ rows: unknown[] }>;
                release: () => void;
            };
            client.query = async (sql) => ({
                rows: sql.includes("pg_advisory_unlock")
                    ? [{ unlocked: true }]
                    : [],
            });
            client.release = () => {
                checkedOut -= 1;
                connectWaiters.shift()?.();
            };
            return client;
        },
    };
    const lock = createPostgresBookLifecycleLock({ pool: fakePool as never });

    const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
            lock.withLock(`book-${index}`, async () => {
                const operationClient = await fakePool.connect();
                operationClient.release();
                return `book-${index}`;
            })
        )
    );

    assert.equal(results.length, 8);
    assert.equal(peakCheckedOut, 4);
    assert.equal(checkedOut, 0);
});

test("PostgreSQL lifecycle lock removes a semaphore waiter after timeout", async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let connectCalls = 0;
    const fakePool = {
        options: { max: 2 },
        connect: async () => {
            connectCalls += 1;
            const client = new EventEmitter() as EventEmitter & {
                query: (sql: string) => Promise<{ rows: unknown[] }>;
                release: () => void;
            };
            client.query = async (sql) => ({
                rows: sql.includes("pg_advisory_unlock")
                    ? [{ unlocked: true }]
                    : [],
            });
            client.release = () => {};
            return client;
        },
    };
    const lock = createPostgresBookLifecycleLock({
        pool: fakePool as never,
        acquireTimeoutMs: 25,
        maxConcurrentLocks: 1,
    });
    const first = lock.withLock("book-1", async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
    });
    await firstEntered.promise;

    await assert.rejects(
        lock.withLock("book-2", async () => {}),
        BookLifecycleLockTimeoutError
    );
    releaseFirst.resolve();
    await first;

    let thirdEntered = false;
    await lock.withLock("book-3", async () => {
        thirdEntered = true;
    });
    assert.equal(thirdEntered, true);
    assert.equal(connectCalls, 2);
});

test("PostgreSQL lifecycle lock aborts and retires a disconnected lock client", async () => {
    const client = new EventEmitter() as EventEmitter & {
        query: (sql: string) => Promise<{ rows: unknown[] }>;
        release: (error?: unknown) => void;
    };
    const queries: string[] = [];
    let releasedWith: unknown;
    client.query = async (sql) => {
        queries.push(sql);
        return sql.includes("pg_advisory_unlock")
            ? { rows: [{ unlocked: true }] }
            : { rows: [] };
    };
    client.release = (error) => {
        releasedWith = error;
    };
    const lock = createPostgresBookLifecycleLock({
        pool: { connect: async () => client } as never,
    });
    const callbackStarted = deferred();
    const finishCallback = deferred();
    const cause = new Error("backend disconnected");
    let receivedSignal: AbortSignal | undefined;
    const operation = lock.withLock("book-1", async (signal) => {
        receivedSignal = signal;
        callbackStarted.resolve();
        await finishCallback.promise;
        return "resolved";
    });

    await callbackStarted.promise;
    assert.doesNotThrow(() => client.emit("error", cause));
    assert.equal(receivedSignal?.aborted, true);
    finishCallback.resolve();

    await assert.rejects(
        operation,
        (error: unknown) =>
            error instanceof BookLifecycleLockLostError &&
            (error as BookLifecycleLockLostError & { cause?: unknown })
                .cause === cause
    );
    assert.ok(releasedWith instanceof Error);
    assert.equal(
        queries.some((sql) => sql.includes("pg_advisory_unlock")),
        false
    );
});

test("artifact cleanup normalizes recognized missing resources only", async () => {
    const cleanup = createBookArtifactCleanup({
        deleteFile: async () => {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        deleteVectorCollection: async () => {
            throw Object.assign(new Error("missing"), {
                name: "ChromaNotFoundError",
            });
        },
        deleteSearchChunks: async () => {},
        clearCache: () => {},
        defaultCollectionName: (bookId) => `collection-${bookId}`,
    });
    await cleanup.deleteFile("file-1");
    await cleanup.deleteVectorCollection("collection-1");

    const failing = createBookArtifactCleanup({
        deleteFile: async () => {
            throw new Error("permission denied");
        },
        deleteVectorCollection: async () => {},
        deleteSearchChunks: async () => {},
        clearCache: () => {},
        defaultCollectionName: (bookId) => `collection-${bookId}`,
    });
    await assert.rejects(failing.deleteFile("file-1"), /permission denied/);
});
