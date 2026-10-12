import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { after, afterEach, before, beforeEach } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
    BookLifecycleLockLostError,
    BookNotFoundError,
    BookProcessingSkippedError,
} from "@reader/domain";
import { ProcessUploadedBook } from "@reader/application";
import { RetryBookProcessing } from "@reader/application";
import { DeleteOwnedBook } from "@reader/application";
import { Pool } from "pg";
import {
    BOOK_PROCESSING_QUEUE_NAME,
    createBookProcessingQueue,
    createBookProcessingJobId,
    enqueueBookProcessingJob,
    getRedisConnectionOptions,
} from "@reader/jobs";
import { Books, Users } from "../src/db/schema";
import { createDrizzleBookRepository } from "../src/infrastructure/books/drizzleBookRepository";
import {
    createBullMqBookQueueControl,
    type BullMqBookQueueControlDependencies,
} from "../src/infrastructure/books/bullmqBookQueueControl";
import { createPostgresBookLifecycleLock } from "../src/infrastructure/books/postgresBookLifecycleLock";

type IntegrationWorker = NodeJS.EventEmitter & {
    close(): Promise<void>;
};
const { Worker } = require("bullmq") as {
    Worker: new (...args: unknown[]) => IntegrationWorker;
};

const queuePrefix = `reader-it-${process.pid}-${Date.now()}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
const repository = createDrizzleBookRepository(db as never);
const lifecycleLock = createPostgresBookLifecycleLock({ pool });
let userId = "";

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

before(async () => {
    assert.ok(process.env.DATABASE_URL);
    assert.ok(process.env.REDIS_URL);
});

after(async () => {
    await pool.end();
});

beforeEach(async () => {
    userId = randomUUID();
    await db.insert(Users).values({
        id: userId,
        email: `${userId}@reader-it.invalid`,
        name: "Lifecycle integration",
    });
});

afterEach(async () => {
    await db.delete(Books).where(eq(Books.userId, userId));
    await db.delete(Users).where(eq(Users.id, userId));
});

const createBook = async (
    processingStatus: string,
    options: {
        collectionName?: string | null;
        fileKey?: string;
        processingError?: string | null;
    } = {}
) => {
    const id = randomUUID();
    const [book] = await db
        .insert(Books)
        .values({
            id,
            title: `${id}.pdf`,
            userId,
            fileKey: options.fileKey ?? `file-${id}`,
            fileType: "pdf",
            collectionName: options.collectionName ?? null,
            processingStatus,
            processingError: options.processingError ?? null,
        })
        .returning();
    return book;
};

const createRetryUseCase = (queue: BullMqBookQueueControlDependencies) =>
    new RetryBookProcessing({
        reads: repository,
        retryState: repository,
        queueState: repository,
        queue: createBullMqBookQueueControl(queue),
        lock: lifecycleLock,
    });

test("concurrent retry has one conditional claimant", async () => {
    const book = await createBook("failed");
    const queueCalls: unknown[] = [];
    const queue = {
        retryOrEnqueue: async (request: unknown) => {
            queueCalls.push(request);
            return "enqueued" as const;
        },
        removePending: async () => {},
    };
    const retry = new RetryBookProcessing({
        reads: repository,
        retryState: repository,
        queueState: repository,
        queue,
        lock: lifecycleLock,
    });

    const outcomes = await Promise.allSettled([
        retry.execute({ bookId: book.id, userId }),
        retry.execute({ bookId: book.id, userId }),
    ]);
    assert.equal(
        outcomes.filter((outcome) => outcome.status === "fulfilled").length,
        1
    );
    assert.equal(queueCalls.length, 1);
    const [stored] = await db.select().from(Books).where(eq(Books.id, book.id));
    assert.equal(stored.processingStatus, "processing");
});

test("a retained failed BullMQ job runs again after retry resets its attempts", async () => {
    const book = await createBook("failed");
    const queue = createBookProcessingQueue({ prefix: queuePrefix });
    const queueControl = createBullMqBookQueueControl({
        queue: queue as never,
        enqueue: (request) => enqueueBookProcessingJob(queue, request),
    });
    let processingCalls = 0;
    const worker = new Worker(
        BOOK_PROCESSING_QUEUE_NAME,
        async () => {
            processingCalls += 1;
            if (processingCalls === 1) throw new Error("first attempt fails");
        },
        {
            connection: getRedisConnectionOptions(),
            prefix: queuePrefix,
        }
    );
    try {
        const failed = once(worker, "failed");
        await queue.add(
            "process-book",
            {
                bookId: book.id,
                userId,
                fileKey: book.fileKey,
                fileType: "pdf",
            },
            {
                jobId: createBookProcessingJobId(book.id),
                attempts: 1,
                removeOnFail: false,
                removeOnComplete: false,
            }
        );
        await failed;
        assert.equal(
            await queue
                .getJob(createBookProcessingJobId(book.id))
                .then((job) => job?.getState()),
            "failed"
        );

        const completed = once(worker, "completed");
        const retry = new RetryBookProcessing({
            reads: repository,
            retryState: repository,
            queueState: repository,
            queue: queueControl,
            lock: lifecycleLock,
        });
        assert.deepEqual(await retry.execute({ bookId: book.id, userId }), {
            bookId: book.id,
            status: "processing",
        });
        await completed;
        assert.equal(processingCalls, 2);
        assert.equal(
            await queue
                .getJob(createBookProcessingJobId(book.id))
                .then((job) => job?.getState()),
            "completed"
        );
    } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
    }
});

test("ready processing replay does not ingest or delete artifacts", async () => {
    const book = await createBook("ready", {
        collectionName: "ready-collection",
    });
    let ingested = 0;
    let deleted = 0;
    const processor = new ProcessUploadedBook({
        repository,
        ingestion: {
            ingest: async () => {
                ingested += 1;
                return {
                    collectionName: "new-collection",
                    chunks: 1,
                    reusedCollection: false,
                };
            },
        },
        cleanup: {
            deleteCollection: async () => {
                deleted += 1;
            },
        },
        references: repository,
        lock: lifecycleLock,
        cache: { clearCollection: () => {} },
    });
    await assert.rejects(
        processor.execute({
            bookId: book.id,
            userId,
            fileKey: book.fileKey,
            fileType: "pdf",
        }),
        (error: unknown) =>
            error instanceof BookProcessingSkippedError &&
            error.reason === "ready"
    );
    assert.equal(ingested, 0);
    assert.equal(deleted, 0);
});

test("deletion racing ingestion rejects publication and cleans the produced collection", async () => {
    const book = await createBook("processing");
    let signalIngestionStarted!: () => void;
    const ingestionStarted = new Promise<void>((resolve) => {
        signalIngestionStarted = resolve;
    });
    let releaseIngestion!: () => void;
    const ingestionGate = new Promise<void>((resolve) => {
        releaseIngestion = resolve;
    });
    const artifacts = new Set<string>();
    const processor = new ProcessUploadedBook({
        repository,
        ingestion: {
            ingest: async () => {
                signalIngestionStarted();
                artifacts.add("new-collection");
                await ingestionGate;
                return {
                    collectionName: "new-collection",
                    chunks: 1,
                    reusedCollection: false,
                };
            },
        },
        cleanup: {
            deleteCollection: async (name) => {
                artifacts.delete(name);
            },
        },
        references: repository,
        lock: lifecycleLock,
        cache: { clearCollection: () => {} },
    });
    const workerPromise = processor.execute({
        bookId: book.id,
        userId,
        fileKey: book.fileKey,
        fileType: "pdf",
    });
    await ingestionStarted;
    let signalDeleting!: () => void;
    const deletingStarted = new Promise<void>((resolve) => {
        signalDeleting = resolve;
    });
    const deletion = new DeleteOwnedBook({
        reads: repository,
        deletion: {
            ...repository,
            markDeleting: async (bookId, ownerId) => {
                const changed = await repository.markDeleting(bookId, ownerId);
                signalDeleting();
                return changed;
            },
        },
        references: repository,
        cleanup: {
            deleteFile: async () => {},
            deleteVectorCollection: async (name) => {
                artifacts.delete(name);
            },
            deleteSearchChunks: async () => {},
            clearCache: () => {},
            defaultCollectionName: (id) => `book_${id}`,
        },
        queue: { removePending: async () => {} },
        lock: lifecycleLock,
    });
    const deletePromise = deletion.execute({ bookId: book.id, userId });
    await deletingStarted;
    releaseIngestion();
    await assert.rejects(
        workerPromise,
        (error: unknown) =>
            error instanceof BookProcessingSkippedError &&
            error.reason === "publication_rejected"
    );
    await deletePromise;
    assert.equal(artifacts.size, 0);
    assert.deepEqual(
        await db.select().from(Books).where(eq(Books.id, book.id)),
        []
    );
});

test("partial delete retries and preserves shared file references", async () => {
    const target = await createBook("ready", {
        collectionName: "unique-collection",
        fileKey: "legacy-shared-file",
    });
    const sibling = await createBook("ready", {
        collectionName: "sibling-collection",
        fileKey: "legacy-shared-file",
    });
    const cleanupCalls: string[] = [];
    let failChunksOnce = true;
    const deletion = new DeleteOwnedBook({
        reads: repository,
        deletion: repository,
        references: repository,
        cleanup: {
            deleteFile: async (key) => {
                cleanupCalls.push(`file:${key}`);
            },
            deleteVectorCollection: async (name) => {
                cleanupCalls.push(`vector:${name}`);
            },
            deleteSearchChunks: async (name) => {
                cleanupCalls.push(`chunks:${name}`);
                if (failChunksOnce) {
                    failChunksOnce = false;
                    throw new Error("temporary chunk cleanup failure");
                }
            },
            clearCache: () => {},
            defaultCollectionName: (id) => `book_${id}`,
        },
        queue: { removePending: async () => {} },
        lock: lifecycleLock,
    });

    await assert.rejects(
        deletion.execute({ bookId: target.id, userId }),
        /temporary chunk cleanup failure/
    );
    const [marked] = await db
        .select()
        .from(Books)
        .where(eq(Books.id, target.id));
    assert.equal(marked.processingStatus, "deleting");
    await deletion.execute({ bookId: target.id, userId });
    assert.equal(
        cleanupCalls.filter((call) => call.startsWith("file:")).length,
        0
    );
    assert.equal(
        cleanupCalls.filter((call) => call === "vector:unique-collection")
            .length,
        2
    );
    const remaining = await db
        .select()
        .from(Books)
        .where(eq(Books.id, sibling.id));
    assert.equal(remaining.length, 1);
});

test("lock resources are released after lifecycle use-case queue failures", async () => {
    const book = await createBook("failed");
    const retry = createRetryUseCase({
        queue: {
            getJob: async () => undefined,
        },
        enqueue: async () => {
            throw new Error("redis unavailable");
        },
    });
    await assert.rejects(
        retry.execute({ bookId: book.id, userId }),
        /redis unavailable/
    );
    let entered = false;
    await lifecycleLock.withLock(book.id, async () => {
        entered = true;
    });
    assert.equal(entered, true);
    const [stored] = await db.select().from(Books).where(eq(Books.id, book.id));
    assert.equal(stored.processingStatus, "queue_failed");
});

test("a max-four pool completes concurrent retries and deletions without starvation", async () => {
    const constrainedPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 4,
    });
    try {
        const constrainedDb = drizzle(constrainedPool);
        const constrainedRepository = createDrizzleBookRepository(
            constrainedDb as never
        );
        const constrainedLock = createPostgresBookLifecycleLock({
            pool: constrainedPool,
        });
        const retry = new RetryBookProcessing({
            reads: constrainedRepository,
            retryState: constrainedRepository,
            queueState: constrainedRepository,
            queue: {
                retryOrEnqueue: async () => "enqueued" as const,
                removePending: async () => {},
            },
            lock: constrainedLock,
        });
        const deletion = new DeleteOwnedBook({
            reads: constrainedRepository,
            deletion: constrainedRepository,
            references: constrainedRepository,
            cleanup: {
                deleteFile: async () => {},
                deleteVectorCollection: async () => {},
                deleteSearchChunks: async () => {},
                clearCache: () => {},
                defaultCollectionName: (id) => `book_${id}`,
            },
            queue: { removePending: async () => {} },
            lock: constrainedLock,
        });
        const retryBooks = await Promise.all(
            Array.from({ length: 8 }, () => createBook("failed"))
        );
        const deleteBooks = await Promise.all(
            Array.from({ length: 8 }, (_, index) =>
                createBook("ready", {
                    collectionName: `delete-collection-${index}`,
                })
            )
        );

        await Promise.all([
            ...retryBooks.map((book) =>
                retry.execute({ bookId: book.id, userId })
            ),
            ...deleteBooks.map((book) =>
                deletion.execute({ bookId: book.id, userId })
            ),
        ]);
    } finally {
        await constrainedPool.end();
    }
});

test("processing survives termination of its advisory-lock backend", async () => {
    const book = await createBook("processing");
    const ingestionStarted = deferred();
    const releaseIngestion = deferred();
    const processor = new ProcessUploadedBook({
        repository,
        ingestion: {
            ingest: async () => {
                ingestionStarted.resolve();
                await releaseIngestion.promise;
                return {
                    collectionName: "terminated-lock-collection",
                    chunks: 1,
                    reusedCollection: false,
                };
            },
        },
        cleanup: { deleteCollection: async () => {} },
        references: repository,
        lock: lifecycleLock,
        cache: { clearCollection: () => {} },
    });
    const processing = processor.execute({
        bookId: book.id,
        userId,
        fileKey: book.fileKey,
        fileType: "pdf",
    });

    try {
        await ingestionStarted.promise;
        const { rows } = await pool.query<{ pid: number }>(
            "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()"
        );
        assert.equal(rows.length, 1);
        const termination = await pool.query<{ terminated: boolean }>(
            "SELECT pg_terminate_backend($1) AS terminated",
            [rows[0].pid]
        );
        assert.equal(termination.rows[0]?.terminated, true);
        await assert.rejects(processing, BookLifecycleLockLostError);
        releaseIngestion.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));

        const [stored] = await db
            .select()
            .from(Books)
            .where(eq(Books.id, book.id));
        assert.equal(stored.processingStatus, "processing");
    } finally {
        releaseIngestion.resolve();
        await processing.catch(() => {});
    }
});

test("a non-owner retry returns not found while the owner's processing lock is held", async () => {
    const book = await createBook("processing");
    const ingestionStarted = deferred();
    const releaseIngestion = deferred();
    const processor = new ProcessUploadedBook({
        repository,
        ingestion: {
            ingest: async () => {
                ingestionStarted.resolve();
                await releaseIngestion.promise;
                return {
                    collectionName: "non-owner-retry-collection",
                    chunks: 1,
                    reusedCollection: false,
                };
            },
        },
        cleanup: { deleteCollection: async () => {} },
        references: repository,
        lock: lifecycleLock,
        cache: { clearCollection: () => {} },
    });
    const processing = processor.execute({
        bookId: book.id,
        userId,
        fileKey: book.fileKey,
        fileType: "pdf",
    });

    try {
        await ingestionStarted.promise;
        const retry = new RetryBookProcessing({
            reads: repository,
            retryState: repository,
            queueState: repository,
            queue: {
                retryOrEnqueue: async () => "enqueued" as const,
                removePending: async () => {},
            },
            lock: createPostgresBookLifecycleLock({
                pool,
                acquireTimeoutMs: 250,
            }),
        });
        const startedAt = Date.now();
        await assert.rejects(
            retry.execute({ bookId: book.id, userId: randomUUID() }),
            BookNotFoundError
        );
        assert.ok(Date.now() - startedAt < 1_000);
    } finally {
        releaseIngestion.resolve();
        await processing;
    }
});
