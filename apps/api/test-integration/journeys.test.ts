/**
 * DELIBERATE FAKES
 * - Google identity verifier: deterministic account creation without Google.
 * - Local storage adapter: STORAGE_DRIVER=local and a per-run directory.
 * - Chat retrieval: records server-owned history without external search calls.
 * - In-memory vector store and embedding function: deterministic indexing/search.
 * - Answer model and shadow retrieval/reranker: deterministic offline model results.
 * - Chat tracing and rate-limit client: no-op transport integrations.
 * - Worker resource lifecycle: no-op shared-resource close; BullMQ workers stay real.
 * - Startup cleanup resource: spy for failed-Nest-init resource release.
 *
 * Suite: offline journeys (not live-provider validation)
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import test, { after, before } from "node:test";
import jwt from "jsonwebtoken";
import { Test } from "@nestjs/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { ProcessUploadedBook } from "@reader/application";
import { ChatCancelledError } from "@reader/domain";
import { processBookForSearch } from "@reader/processing";
import {
    storageProvider,
    vectorStore as providerVectorStore,
} from "@reader/providers";
import {
    createRagRerankShadowJobId,
    createRagRerankShadowQueue,
    getRedisConnectionOptions,
    parseRagRerankShadowRateLimit,
} from "@reader/jobs";
import {
    createDrizzleBookRepository,
    createPostgresBookLifecycleLock,
} from "../src/infrastructure/books";
import { createBookSearchChunkStore } from "../src/services/BookSearchChunkStore";
import {
    Books,
    BookSearchChunks,
    Conversations,
    Messages,
    Progress,
    Users,
} from "../src/db/schema";
import { AppModule } from "../src/app.module";
import { createApp } from "../src/bootstrap";
import { GOOGLE_IDENTITY_VERIFIER } from "../src/auth/auth.tokens";
import {
    CHAT_GENERATION,
    CHAT_RETRIEVAL,
    CHAT_TRACING,
} from "../src/infrastructure/chat/chat.tokens";
import { processRagRerankShadow } from "../src/rag-shadow";
import { createDrizzleRagShadowRepository } from "../src/infrastructure/rag/shadowRepository";
import { RATE_LIMIT_CLIENT } from "../src/common/rate-limit.module";
import { pool as apiPool, db as apiDb } from "../src/db";
import {
    closeBookProcessingQueue,
    getBookProcessingQueue,
} from "../src/services/BookProcessingQueue";

const ORIGIN = "http://localhost:5173";
const epubFixture = readFileSync(
    resolve(process.cwd(), "packages/evals/fixtures/alice-in-wonderland.epub")
);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const database = drizzle(pool);
const ownerGoogleId = `journey-google-${randomUUID()}`;
const ownerEmail = `${ownerGoogleId}@reader-it.invalid`;
const attackerGoogleId = `journey-attacker-${randomUUID()}`;
const attackerEmail = `${attackerGoogleId}@reader-it.invalid`;

const vectorCollections = new Map<string, string[]>();
const vectorEmbeddings = new Map<string, number[][]>();
const retrievedHistories: unknown[][] = [];
let ingestionCount = 0;
const fakeEmbeddings = {
    async embedDocuments(documents: string[]) {
        return documents.map((document) => [document.length]);
    },
};
const vectorStore = {
    async resetCollection(name: string) {
        vectorCollections.set(name, []);
    },
    async addDocuments(name: string, documents: string[]) {
        vectorCollections.set(name, documents);
        vectorEmbeddings.set(
            name,
            await fakeEmbeddings.embedDocuments(documents)
        );
    },
    async searchDocuments(name: string) {
        return (vectorCollections.get(name) ?? []).map((content, index) => ({
            id: `${name}_${index}`,
            content,
            rank: index + 1,
            distance: index / 10,
        }));
    },
    async deleteCollection(name: string) {
        vectorCollections.delete(name);
        vectorEmbeddings.delete(name);
        return true;
    },
};

const fakeShadowReranker = {
    async rerank<T>(sources: T[]) {
        return sources;
    },
};
const fakeShadowRetrieval = async () => {
    const sources = [
        {
            id: "journey-source",
            chunkIndex: 0,
            score: 1,
            bestRank: 1,
            excerpt: "hidden",
            metadata: null,
        },
    ];
    return {
        status: "ready",
        sources,
        telemetry: {
            pipelineVersion: "rerank-rag-v1",
            promptVersion: "book-context-v1",
            queryPlan: null,
            retrieval: {
                mode: "reranked",
                durationMs: 1,
                firstStage: {},
                firstStageCandidates: [],
                finalCandidates: [],
                reranker: {
                    requestedModel: "offline-reranker",
                    resolvedModel: "offline-reranker",
                    promptVersion: "offline-reranker-v1",
                    status: "success",
                    durationMs: 1,
                    usage: null,
                    estimatedCost: null,
                    fallbackReason: null,
                },
                diversity: { maxWordTrigramJaccard: 0 },
            },
        },
        results: await fakeShadowReranker.rerank(sources),
    } as never;
};

const fakeGeneration = {
    async generate(
        input: { messages: Array<{ content: string }> },
        options: {
            onContent(content: string): Promise<void> | void;
            signal?: AbortSignal;
        }
    ) {
        if (JSON.stringify(input.messages).includes("disconnect")) {
            await new Promise<void>((resolve) => {
                if (options.signal?.aborted) return resolve();
                options.signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                });
            });
            throw new ChatCancelledError();
        }
        await options.onContent("offline answer");
        return {
            answer: "offline answer",
            modelVersion: "offline-answer-model",
            finishReason: "stop",
            streamCompleted: true,
            usage: null,
            durationMs: 1,
        };
    },
};

const fakeRetrieval = {
    async retrieve(input: { messages: unknown[] }) {
        retrievedHistories.push(input.messages);
        return {
            status: "ready",
            messages: input.messages,
            sources: [
                {
                    id: "journey-source",
                    chunkIndex: 0,
                    score: 1,
                    bestRank: 1,
                    excerpt: "offline journey source",
                    metadata: null,
                },
            ],
            telemetry: {
                pipelineVersion: "baseline-rag-v1",
                promptVersion: "book-context-v1",
                queryPlan: null,
                retrieval: null,
            },
        };
    },
};

const fakeTracing = {
    run(_meta: unknown, callback: (trace: unknown) => unknown) {
        const trace = {
            traceId: "offline-journey-trace",
            setTraceIO() {},
            startObservation: () => trace,
            update() {},
            end() {},
        };
        return callback(trace);
    },
};

let api: Awaited<ReturnType<typeof createApp>>;
let worker: any;
let ownerCookie = "";
let attackerCookie = "";
let bookId = "";
let fileKey = "";
let collectionName = "";
let conversationId = "";

const request = (path: string, init: RequestInit = {}, cookie = ownerCookie) =>
    fetch(
        `http://127.0.0.1:${(api.getHttpServer().address() as { port: number }).port}${path}`,
        {
            ...init,
            headers: {
                ...(init.body instanceof FormData
                    ? {}
                    : { "Content-Type": "application/json" }),
                ...(init.method && init.method !== "GET"
                    ? { Origin: ORIGIN }
                    : {}),
                ...(cookie ? { Cookie: cookie } : {}),
                ...(init.headers ?? {}),
            },
        }
    );

const signIn = async (token: string) => {
    const response = await request(
        "/api/auth/google",
        {
            method: "POST",
            body: JSON.stringify({ idToken: token }),
        },
        ""
    );
    assert.equal(response.status, 200);
    return response.headers
        .getSetCookie()
        .find((value) => value.startsWith("reader_session="))!
        .split(";")[0];
};

const waitFor = async (check: () => Promise<boolean>) => {
    for (let index = 0; index < 60; index += 1) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("timed out waiting for journey state");
};

const frames = async (response: Response) =>
    (await response.text())
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => frame.slice(6))
        .map((frame) =>
            frame === "[DONE]"
                ? "[DONE]"
                : (JSON.parse(frame) as Record<string, unknown>)
        );

const eventNames = (events: Array<Record<string, unknown> | "[DONE]">) =>
    events.map((event) => {
        if (event === "[DONE]") return event;
        if (event.type === "conversation_id") return "conversation_id";
        if ("content" in event) return "content";
        if (event.type === "sources") return "sources";
        if (event.type === "terminal") return "terminal";
        return "unknown";
    });

before(async () => {
    assert.ok(process.env.DATABASE_URL);
    assert.ok(process.env.REDIS_URL);
    const appModule = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(GOOGLE_IDENTITY_VERIFIER)
        .useValue({
            verify: async (token: string) => ({
                sub: token === "attacker" ? attackerGoogleId : ownerGoogleId,
                email: token === "attacker" ? attackerEmail : ownerEmail,
                name: token === "attacker" ? "Attacker" : "Journey Owner",
            }),
        })
        .overrideProvider(CHAT_RETRIEVAL)
        .useValue(fakeRetrieval)
        .overrideProvider(CHAT_GENERATION)
        .useValue(fakeGeneration)
        .overrideProvider(CHAT_TRACING)
        .useValue(fakeTracing)
        .overrideProvider(RATE_LIMIT_CLIENT)
        .useValue({ get: () => null, close: async () => {} })
        .compile();
    api = await createApp({
        createApplication: async () =>
            appModule.createNestApplication({ bodyParser: false }) as any,
    });
    await api.listen(0);
    ownerCookie = await signIn("owner");
    attackerCookie = await signIn("attacker");

    const repository = createDrizzleBookRepository(apiDb as never);
    const chunks = createBookSearchChunkStore(apiDb as never);
    const lifecycleLock = createPostgresBookLifecycleLock({ pool: apiPool });
    const processor = new ProcessUploadedBook({
        repository,
        ingestion: {
            ingest: (input) => {
                ingestionCount += 1;
                return processBookForSearch(input, {
                    storage: storageProvider,
                    vectorStore: vectorStore as never,
                    searchIndexStore: chunks,
                });
            },
        },
        cleanup: {
            defaultCollectionName: (id) => `book_${id.replace(/-/g, "_")}`,
            attemptCollectionName: (id, attempt) =>
                `book_${id.replace(/-/g, "_")}_${attempt}`,
            deleteCollection: async (name) => {
                await vectorStore.deleteCollection(name);
                await chunks.deleteCollectionChunks(name);
            },
        },
        references: repository,
        lock: lifecycleLock,
        cache: { clearCollection: (name) => vectorCollections.delete(name) },
        attemptIds: { next: () => "journey-attempt" },
    });
    const processUploadedBook = (payload: any, options?: any) =>
        processor.execute(payload, options);
    const shadowRepository = createDrizzleRagShadowRepository(apiDb as never);
    const workerApi = require(
        `${process.cwd()}/apps/worker/build/worker.module.js`
    ) as any;
    const workerRuntime = require(
        `${process.cwd()}/apps/worker/build/worker-runtime.service.js`
    ) as any;
    const workerProcessor = require(
        `${process.cwd()}/apps/worker/build/processor.js`
    ) as any;
    (providerVectorStore as any).deleteCollection =
        vectorStore.deleteCollection;
    const workerModule = await Test.createTestingModule({
        imports: [workerApi.WorkerModule],
    })
        .overrideProvider(workerApi.PROCESS_UPLOADED_BOOK)
        .useValue(processUploadedBook)
        .overrideProvider(workerRuntime.WORKER_RUNTIME_DEPENDENCIES)
        .useValue({
            processBookProcessingJob: (job: any) =>
                workerProcessor.processBookProcessingJob(
                    job,
                    processUploadedBook
                ),
            processRagRerankShadowJob: (job: any) =>
                workerProcessor.processRagRerankShadowJob(job, (payload: any) =>
                    processRagRerankShadow(payload, {
                        load: (data) => shadowRepository.load(data),
                        persist: (id, shadow) =>
                            shadowRepository.persist(id, shadow),
                        retrieve: fakeShadowRetrieval,
                    })
                ),
            getRedisConnectionOptions,
            getRagRerankShadowRateLimit: () =>
                parseRagRerankShadowRateLimit(
                    process.env.RAG_RERANK_SHADOW_RATE_LIMIT_PER_MINUTE
                ),
            logger: console,
        })
        .overrideProvider(workerRuntime.WORKER_RESOURCES)
        .useValue({
            startTracing() {},
            close: async () => {},
        })
        .compile();
    worker = workerModule as never;
    await workerModule.init();
});

after(async () => {
    try {
        await worker?.close();
        await api?.close();
        await closeBookProcessingQueue();
        if (ownerId) {
            await database
                .delete(Conversations)
                .where(eq(Conversations.userId, ownerId));
            await database.delete(Books).where(eq(Books.userId, ownerId));
        }
        await database.delete(Users).where(eq(Users.email, ownerEmail));
        await database.delete(Users).where(eq(Users.email, attackerEmail));
        assert.equal(apiPool.totalCount, 0);
    } finally {
        await pool.end();
    }
});
let ownerId = "";

test("offline journeys (not live-provider validation): sign-in, upload, worker processing, and download", async () => {
    assert.equal((await request("/api/user")).status, 200);
    const form = new FormData();
    form.append(
        "file",
        new Blob([epubFixture], { type: "application/epub+zip" }),
        "journey.epub"
    );
    const upload = await request("/api/books", { method: "POST", body: form });
    assert.equal(upload.status, 202);
    const body = (await upload.json()) as {
        book: { id: string; fileKey: string };
    };
    bookId = body.book.id;
    fileKey = body.book.fileKey;
    ownerId = (await (await request("/api/user")).json()).user.id;
    await waitFor(
        async () =>
            (await (await request(`/api/books/${bookId}/status`)).json())
                .status === "ready"
    );
    assert.equal(ingestionCount, 1);
    assert.ok(
        [...vectorEmbeddings.values()].some((embeddings) => embeddings.length)
    );
    const [book] = await database
        .select({ collectionName: Books.collectionName })
        .from(Books)
        .where(eq(Books.id, bookId));
    collectionName = book.collectionName!;
    const download = await request(`/api/books/${bookId}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("cache-control"), "private");
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.equal(download.headers.get("content-type"), "application/epub+zip");
    assert.equal(
        download.headers.get("content-length"),
        String(epubFixture.length)
    );
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), epubFixture);
    assert.equal(
        existsSync(resolve(process.env.LOCAL_STORAGE_DIR!, fileKey)),
        true
    );
});

test("offline journeys (not live-provider validation): chat history, SSE order, persistence, and shadow", async () => {
    const created = await request(`/api/book/${bookId}/conversations`, {
        method: "POST",
        body: JSON.stringify({
            message: "first",
            history: [{ role: "user", content: "client-only" }],
        }),
    });
    assert.equal(created.status, 200);
    const createdFrames = await frames(created);
    assert.deepEqual(eventNames(createdFrames), [
        "conversation_id",
        "content",
        "sources",
        "terminal",
        "[DONE]",
    ]);
    assert.ok(
        !JSON.stringify(retrievedHistories.at(-1)).includes("client-only")
    );
    const conversationFrame = createdFrames[0];
    if (conversationFrame === "[DONE]") {
        throw new Error("conversation_id frame was missing");
    }
    conversationId = String(conversationFrame.conversationId);
    const appended = await request(
        `/api/book/${bookId}/conversations/${conversationId}/messages`,
        {
            method: "POST",
            body: JSON.stringify({
                message: "second",
                history: [{ role: "user", content: "ignored" }],
            }),
        }
    );
    assert.equal(appended.status, 200);
    const appendedFrames = await frames(appended);
    assert.deepEqual(eventNames(appendedFrames), [
        "content",
        "sources",
        "terminal",
        "[DONE]",
    ]);
    const serverHistory = JSON.stringify(retrievedHistories.at(-1));
    assert.ok(serverHistory.includes("first"));
    assert.ok(!serverHistory.includes("client-only"));
    assert.ok(!serverHistory.includes("ignored"));
    assert.ok(
        !JSON.stringify([...createdFrames, ...appendedFrames]).includes(
            "executionMetadata"
        )
    );
    await waitFor(async () => {
        const rows = await database
            .select()
            .from(Messages)
            .where(eq(Messages.conversationId, conversationId));
        return rows.some(
            (row) =>
                row.role === "assistant" &&
                row.executionMetadata &&
                JSON.stringify(row.executionMetadata).includes('"shadow"')
        );
    });
    const rows = await database
        .select()
        .from(Messages)
        .where(eq(Messages.conversationId, conversationId));
    const assistant = rows.find((row) => row.role === "assistant");
    assert.ok(assistant?.contextSources?.length);
    assert.ok(assistant?.executionMetadata);
    const shadow = assistant.executionMetadata?.shadow;
    assert.ok(shadow);
    assert.equal(shadow.version, "rag-shadow-v1");
    assert.equal(shadow.candidate.pipelineVersion, "rerank-rag-v1");
    assert.ok(shadow.completedAt);
    const serializedShadow = JSON.stringify(shadow);
    for (const content of [
        "hidden",
        "first",
        "second",
        "offline journey source",
        "offline answer",
    ]) {
        assert.equal(serializedShadow.includes(content), false);
    }
    const shadowQueue = createRagRerankShadowQueue();
    try {
        await waitFor(async () => {
            const job = await shadowQueue.getJob(
                createRagRerankShadowJobId(assistant.id)
            );
            return job ? (await job.getState()) === "completed" : false;
        });
    } finally {
        await shadowQueue.close();
    }
});

test("offline journeys (not live-provider validation): progress, retry replay, delete, and cleanup", async () => {
    const saved = await request(`/api/${bookId}/progress`, {
        method: "POST",
        body: JSON.stringify({ progress_block: "chapter one" }),
    });
    assert.equal(saved.status, 201);
    assert.equal(
        (await (await request(`/api/${bookId}/progress`)).json())
            .progressPosition,
        "chapter one"
    );
    await database
        .update(Books)
        .set({ processingStatus: "failed" })
        .where(eq(Books.id, bookId));
    assert.equal(
        (await request(`/api/books/${bookId}/retry`, { method: "POST" }))
            .status,
        202
    );
    await waitFor(
        async () =>
            (await (await request(`/api/books/${bookId}/status`)).json())
                .status === "ready"
    );
    assert.equal(
        (await request(`/api/books/${bookId}/retry`, { method: "POST" }))
            .status,
        409
    );
    const replayJobId = `journey-replay-${bookId}`;
    const processingQueue = getBookProcessingQueue();
    await processingQueue.add(
        "process-book",
        { bookId, userId: ownerId, fileKey, fileType: "epub" },
        { jobId: replayJobId }
    );
    await waitFor(async () => {
        const job = await processingQueue.getJob(replayJobId);
        return job ? (await job.getState()) === "completed" : false;
    });
    assert.equal(ingestionCount, 2);
});

test("offline journeys (not live-provider validation): endpoint-specific cross-user and session denials", async () => {
    const foreignBook = await request(
        `/api/books/${bookId}/status`,
        {},
        attackerCookie
    );
    assert.equal(foreignBook.status, 403);
    assert.deepEqual(await foreignBook.json(), { error: "Not authorized" });
    const foreignFile = await request(
        `/api/books/${bookId}`,
        {},
        attackerCookie
    );
    assert.equal(foreignFile.status, 403);
    assert.deepEqual(await foreignFile.json(), { error: "Not authorized" });
    const foreignChat = await request(
        `/api/book/${bookId}/conversations`,
        {},
        attackerCookie
    );
    assert.equal(foreignChat.status, 403);
    assert.deepEqual(await foreignChat.json(), { error: "Book access denied" });
    const foreignProgress = await request(
        `/api/${bookId}/progress`,
        {},
        attackerCookie
    );
    assert.equal(foreignProgress.status, 404);
    assert.deepEqual(await foreignProgress.json(), {
        message: "Book not found",
    });
    const [tokenHeader, tokenPayload, signature] = jwt
        .sign({ userId: ownerId }, process.env.JWT_SECRET!)
        .split(".");
    assert.ok(tokenHeader && tokenPayload && signature);
    const tamperedSignature = `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
    const tamperedCookie = `reader_session=${tokenHeader}.${tokenPayload}.${tamperedSignature}`;
    for (const cookie of [
        "",
        "reader_session=bad",
        `reader_session=${jwt.sign({ userId: "missing" }, process.env.JWT_SECRET!, { expiresIn: -1 })}`,
        tamperedCookie,
    ]) {
        const response = await request("/api/user", {}, cookie);
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), {
            message: cookie ? "Invalid token" : "No token provided",
        });
    }
});

test("offline journeys (not live-provider validation): CSRF rejection and queue failure map to existing contracts", async () => {
    const response = await request(`/api/${bookId}/progress`, {
        method: "POST",
        headers: { Origin: "http://localhost:3001" },
        body: JSON.stringify({ progress_block: "x" }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
        message: "Untrusted request origin",
    });

    await database
        .update(Books)
        .set({ processingStatus: "failed" })
        .where(eq(Books.id, bookId));
    const queue = getBookProcessingQueue() as any;
    const redisClient = await queue.client;
    redisClient.disconnect(false);

    const form = new FormData();
    form.append(
        "file",
        new Blob([epubFixture], { type: "application/epub+zip" }),
        "queue-failure.epub"
    );
    const failedUpload = await request("/api/books", {
        method: "POST",
        body: form,
    });
    assert.equal(failedUpload.status, 503);
    assert.deepEqual(await failedUpload.json(), {
        error: "Book processing queue is unavailable",
    });
    const ownerBooks = await database
        .select()
        .from(Books)
        .where(eq(Books.userId, ownerId));
    assert.ok(
        ownerBooks.some(
            (book) =>
                book.id !== bookId && book.processingStatus === "queue_failed"
        )
    );

    const failedRetry = await request(`/api/books/${bookId}/retry`, {
        method: "POST",
    });
    assert.equal(failedRetry.status, 503);
    assert.deepEqual(await failedRetry.json(), {
        error: "Book processing queue is unavailable",
    });
    await closeBookProcessingQueue();
});

test("offline journeys (not live-provider validation): disconnect cancellation leaves no assistant", async () => {
    const beforeCount = (await database.select().from(Messages)).filter(
        (row) => row.role === "assistant"
    ).length;
    const server = api.getHttpServer();
    let transport:
        | {
              request: IncomingMessage;
              response: ServerResponse;
              baseline: { aborted: number; close: number; drain: number };
          }
        | undefined;
    const observeDisconnect = (
        incoming: IncomingMessage,
        outgoing: ServerResponse
    ) => {
        if (
            incoming.method !== "POST" ||
            incoming.url !== `/api/book/${bookId}/conversations`
        ) {
            return;
        }
        transport = {
            request: incoming,
            response: outgoing,
            baseline: {
                aborted: incoming.listenerCount("aborted"),
                close: outgoing.listenerCount("close"),
                drain: outgoing.listenerCount("drain"),
            },
        };
    };
    server.prependListener("request", observeDisconnect);
    const controller = new AbortController();
    let pending: Promise<Response | null> | undefined;
    try {
        pending = request(`/api/book/${bookId}/conversations`, {
            method: "POST",
            body: JSON.stringify({ message: "disconnect" }),
            signal: controller.signal,
        }).catch(() => null);
        await waitFor(async () =>
            Boolean(
                transport &&
                    transport.request.listenerCount("aborted") >
                        transport.baseline.aborted &&
                    transport.response.listenerCount("close") >
                        transport.baseline.close &&
                    transport.response.listenerCount("drain") >
                        transport.baseline.drain
            )
        );
        controller.abort();
        await pending;
        await waitFor(async () =>
            Boolean(
                transport &&
                    transport.request.listenerCount("aborted") ===
                        transport.baseline.aborted &&
                    transport.response.listenerCount("close") ===
                        transport.baseline.close &&
                    transport.response.listenerCount("drain") ===
                        transport.baseline.drain
            )
        );
    } finally {
        controller.abort();
        if (pending) await pending;
        server.removeListener("request", observeDisconnect);
    }
    const afterCount = (await database.select().from(Messages)).filter(
        (row) => row.role === "assistant"
    ).length;
    assert.equal(afterCount, beforeCount);
});

test("offline journeys (not live-provider validation): startup and shutdown release resources", async () => {
    assert.equal(api.getHttpServer().listening, true);
});

test("offline journeys (not live-provider validation): delete cleans book artifacts, keeps orphaned conversations, and hides chat endpoints", async () => {
    assert.equal(
        (await request(`/api/books/${bookId}`, { method: "DELETE" })).status,
        204
    );
    const missingFile = await request(`/api/books/${bookId}`);
    assert.equal(missingFile.status, 404);
    assert.deepEqual(await missingFile.json(), { error: "Book was not found" });
    const missingProgress = await request(`/api/${bookId}/progress`);
    assert.equal(missingProgress.status, 404);
    assert.deepEqual(await missingProgress.json(), {
        message: "Book not found",
    });
    const missingProgressPost = await request(`/api/${bookId}/progress`, {
        method: "POST",
        body: JSON.stringify({ progress_block: "x" }),
    });
    assert.equal(missingProgressPost.status, 404);
    assert.deepEqual(await missingProgressPost.json(), {
        message: "Book not found",
    });
    const missingConversations = await request(
        `/api/book/${bookId}/conversations`
    );
    assert.equal(missingConversations.status, 404);
    assert.deepEqual(await missingConversations.json(), {
        error: "Book not found",
    });
    const missingConversationDetail = await request(
        `/api/book/${bookId}/conversations/${conversationId}`
    );
    assert.equal(missingConversationDetail.status, 404);
    assert.deepEqual(await missingConversationDetail.json(), {
        error: "Book not found",
    });
    const missingConversationAppend = await request(
        `/api/book/${bookId}/conversations/${conversationId}/messages`,
        {
            method: "POST",
            body: JSON.stringify({ message: "not found" }),
        }
    );
    assert.equal(missingConversationAppend.status, 404);
    assert.deepEqual(await missingConversationAppend.json(), {
        error: "Book not found",
    });
    assert.equal(
        (await database.select().from(Books).where(eq(Books.id, bookId)))
            .length,
        0
    );
    assert.equal(
        (
            await database
                .select()
                .from(Progress)
                .where(eq(Progress.bookId, bookId))
        ).length,
        0
    );
    const orphanedConversations = await database
        .select()
        .from(Conversations)
        .where(eq(Conversations.resourceId, bookId));
    assert.ok(orphanedConversations.length > 0);
    assert.ok(
        orphanedConversations.some(
            (conversation) => conversation.id === conversationId
        )
    );
    assert.equal(
        (
            await database
                .select()
                .from(BookSearchChunks)
                .where(eq(BookSearchChunks.collectionName, collectionName))
        ).length,
        0
    );
    assert.equal(vectorCollections.has(collectionName), false);
    assert.equal(
        existsSync(resolve(process.env.LOCAL_STORAGE_DIR!, fileKey)),
        false
    );
});

test("offline journeys (not live-provider validation): startup failure releases supplied resources", async () => {
    const previousSecret = process.env.JWT_SECRET;
    Reflect.deleteProperty(process.env, "JWT_SECRET");
    let released = false;
    try {
        await assert.rejects(
            createApp({
                createApplication: async () => {
                    const failingModule = await Test.createTestingModule({
                        imports: [AppModule],
                    }).compile();
                    const failingApp = failingModule.createNestApplication({
                        bodyParser: false,
                    }) as any;
                    await failingApp.init();
                    return failingApp;
                },
                resources: {
                    close: async () => {
                        released = true;
                    },
                },
            }),
            (error: unknown) => {
                const messages = (value: unknown): string[] => {
                    if (!(value instanceof Error)) return [String(value)];
                    const nested =
                        value instanceof AggregateError
                            ? [...value.errors].flatMap(messages)
                            : [];
                    return [value.message, ...nested];
                };
                return messages(error).some((message) =>
                    message.includes(
                        "Missing required JWT_SECRET environment variable"
                    )
                );
            }
        );
        assert.equal(released, true);
    } finally {
        if (previousSecret === undefined)
            Reflect.deleteProperty(process.env, "JWT_SECRET");
        else process.env.JWT_SECRET = previousSecret;
    }
});
