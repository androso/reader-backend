import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type {
    DbStep,
    RecordedEffect,
    ScriptedDbQueryHandler,
} from "./helpers/httpParity";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";
process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";
process.env.LANGFUSE_SAMPLE_RATE = "0";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.REDIS_URL = "";

const helper =
    require("./helpers/httpParity") as typeof import("./helpers/httpParity");
const { createTestApp } =
    require("./helpers/nestApp") as typeof import("./helpers/nestApp");
const { DRIZZLE } =
    require("../src/database/database.module") as typeof import("../src/database/database.module");
const { CHAT_OPERATIONS, createChatOperations, defaultChatStreamDependencies } =
    require("../src/chat/chat-stream") as typeof import("../src/chat/chat-stream");
const { APPEND_BOOK_CHAT, START_BOOK_CHAT } =
    require("../src/infrastructure/chat/chat.tokens") as typeof import("../src/infrastructure/chat/chat.tokens");
const { RATE_LIMIT_CLIENT } =
    require("../src/common/rate-limit.module") as typeof import("../src/common/rate-limit.module");
const { AUTH_OPERATIONS } =
    require("../src/auth/auth.operations") as typeof import("../src/auth/auth.operations");
const { BOOKS_PORTS } =
    require("../src/books/books.ports") as typeof import("../src/books/books.ports");
const { generateToken, getOrCreateDevUser } =
    require("../src/services/AuthService") as typeof import("../src/services/AuthService");
const { drizzle } =
    require("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken");

type EffectRecord = Record<string, unknown> & { type: string };

type RetrieveStub = { result?: unknown; error?: string };
type GenerateStub = {
    chunks?: string[];
    waitForClientAfter?: number;
    errorBeforeChunks?: string;
    errorAfterChunks?: string;
    result?: Record<string, unknown>;
};
type ShadowStub = { defer?: boolean; error?: string };

type FixtureScenario = {
    id: string;
    transport?:
        | "destroy-after-first-content"
        | "slow-reader"
        | "abort-mid-body";
    request: {
        method: string;
        path: string;
        body?: { kind: string; value?: unknown; text?: string };
    };
    db: DbStep[];
    stubs?: {
        retrieve?: RetrieveStub;
        generate?: GenerateStub;
        shadow?: ShadowStub;
    };
    capture: {
        status: number;
        headers: Record<string, string | null>;
        frames: unknown[];
        effects: EffectRecord[];
        markers: Record<string, unknown>;
        processEvents?: unknown[];
        unconsumedDbSteps?: number;
        error?: string;
    };
};

const resolveFixturePath = () => {
    const candidates = [
        path.resolve(
            __dirname,
            "../../../apps/api/test/fixtures/chat-sse-parity.json"
        ),
        path.resolve(process.cwd(), "test/fixtures/chat-sse-parity.json"),
        path.resolve(
            process.cwd(),
            "apps/api/test/fixtures/chat-sse-parity.json"
        ),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
        throw new Error(
            `chat-sse fixture not found; tried ${candidates.join(", ")}`
        );
    }
    return found;
};

const FIXTURE = JSON.parse(fs.readFileSync(resolveFixturePath(), "utf8")) as {
    meta: Record<string, unknown>;
    scenarios: FixtureScenario[];
};

const deferred = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

type Deferred = ReturnType<typeof deferred>;

const ctx: {
    effects: EffectRecord[];
    processEvents: EffectRecord[];
    stubs: NonNullable<FixtureScenario["stubs"]>;
    dbHandler: ScriptedDbQueryHandler | null;
    generateLatch: Deferred | null;
    queueLatch: Deferred | null;
    queuePending: boolean;
    queueSettledWaiter: Deferred | null;
    shadowInputs: Record<string, unknown>[];
} = {
    effects: [],
    processEvents: [],
    stubs: {},
    dbHandler: null,
    generateLatch: null,
    queueLatch: null,
    queuePending: false,
    queueSettledWaiter: null,
    shadowInputs: [],
};

const record = (effect: EffectRecord) => {
    ctx.effects.push(effect);
};

const onProcessEvent = (event: string) => (error: unknown) => {
    ctx.processEvents.push({
        type: "process",
        event,
        message: error instanceof Error ? error.message : String(error),
    });
};
const uncaughtHandler = onProcessEvent("uncaughtException");
const rejectionHandler = onProcessEvent("unhandledRejection");

const fakePgClient = {
    query: async (queryConfig: unknown, params?: unknown[]) => {
        if (!ctx.dbHandler) {
            throw new Error("db query without scripted handler");
        }
        const sqlText =
            typeof queryConfig === "string"
                ? queryConfig
                : (queryConfig as { text?: string } | null | undefined)?.text;
        const result = await ctx.dbHandler(queryConfig, params);
        const columns = helper.extractResultColumns(String(sqlText ?? ""));
        return {
            rows: (result.rows ?? []).map((row) =>
                Array.isArray(row)
                    ? row
                    : helper.projectRowToDriverArray(
                          row as Record<string, unknown>,
                          columns
                      )
            ),
        };
    },
    connect: async () => fakePgClient,
    release: () => undefined,
    end: async () => undefined,
};
const fakeDb = drizzle(fakePgClient as never);

const chatDependencies = {
    ...defaultChatStreamDependencies,
    db: fakeDb as never,
    retrieveBookContext: (async (args: {
        bookId: string;
        userId: string;
        query: string;
        messages: unknown;
        signal?: AbortSignal;
        highlightContext?: unknown;
    }) => {
        record({
            type: "rag",
            op: "retrieveBookContext",
            bookId: args.bookId,
            userId: args.userId,
            query: args.query,
            messages: args.messages,
            hasSignal: Boolean(args.signal),
            hasHighlightContext: Boolean(args.highlightContext),
        });
        const script = ctx.stubs.retrieve;
        if (!script) throw new Error("retrieveBookContext not scripted");
        if (script.error) throw new Error(script.error);
        return script.result;
    }) as never,
    generateBookAnswer: (async (args: {
        model: string;
        messages: unknown;
        options?: { signal?: AbortSignal; langfuse?: unknown };
        onContent?: (content: string) => void;
        shouldContinue?: () => boolean;
    }) => {
        record({
            type: "rag",
            op: "generateBookAnswer",
            model: args.model,
            messages: args.messages,
            hasSignal: Boolean(args.options && args.options.signal),
            hasLangfuseOption: Boolean(args.options && args.options.langfuse),
        });
        const script = ctx.stubs.generate;
        if (!script) throw new Error("generateBookAnswer not scripted");
        if (script.errorBeforeChunks) {
            throw new Error(script.errorBeforeChunks);
        }
        const chunks = script.chunks ?? [];
        for (let i = 0; i < chunks.length; i++) {
            if (!args.shouldContinue || args.shouldContinue()) {
                args.onContent?.(chunks[i]);
            }
            if (script.waitForClientAfter === i) {
                ctx.generateLatch = deferred();
                await ctx.generateLatch.promise;
                ctx.generateLatch = null;
            }
        }
        if (script.errorAfterChunks) {
            throw new Error(script.errorAfterChunks);
        }
        const result = { ...(script.result ?? {}) };
        if (result.modelVersion === "$requestedModel") {
            result.modelVersion = args.model;
        }
        return result;
    }) as never,
    maybeEnqueueRagRerankShadow: (async (input: Record<string, unknown>) => {
        ctx.shadowInputs.push(input);
        const { hasHighlightContext: _ignored, ...payload } = input;
        record({
            type: "queue",
            queue: "rag-rerank-shadow",
            op: "add",
            payload,
        });
        const script = ctx.stubs.shadow ?? {};
        const settle = async (outcome: "resolved" | "rejected") => {
            record({
                type: "queue",
                queue: "rag-rerank-shadow",
                op: "settled",
                outcome,
                ...(outcome === "rejected" ? { error: script.error } : {}),
            });
            if (outcome === "rejected") {
                throw new Error(script.error ?? "enqueue failed");
            }
        };
        if (script.defer === false) {
            await settle(script.error ? "rejected" : "resolved");
            return "enqueued";
        }
        ctx.queuePending = true;
        ctx.queueLatch = deferred();
        const settled = deferred();
        ctx.queueSettledWaiter = settled;
        try {
            await ctx.queueLatch.promise;
            await settle("resolved");
            return "enqueued";
        } catch (error) {
            await settle("rejected").catch(() => undefined);
            return "enqueue_failed";
        } finally {
            ctx.queuePending = false;
            settled.resolve();
        }
    }) as never,
};

const SSE_HEADER_NAMES = [
    "content-type",
    "cache-control",
    "connection",
    "transfer-encoding",
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "vary",
] as const;

const parseFrameBlock = (block: string): unknown => {
    const dataLines = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
    if (!dataLines.length) return undefined;
    const data = dataLines.join("\n");
    if (data === "[DONE]") return "[DONE]";
    return JSON.parse(data);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type RawCapture = {
    status: number;
    headers: Record<string, string | null>;
    frames: unknown[];
    effects: unknown;
    markers: Record<string, unknown>;
    processEvents: EffectRecord[];
    unconsumedDbSteps: number;
};

const normalizeMetadataParams = (value: unknown): unknown => {
    if (typeof value === "string") {
        if (!(value.startsWith("{") || value.startsWith("["))) return value;
        let parsed: unknown;
        try {
            parsed = JSON.parse(value);
        } catch {
            return value;
        }
        return normalizeMetadataParams(parsed);
    }
    if (Array.isArray(value)) return value.map(normalizeMetadataParams);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(
            value as Record<string, unknown>
        )) {
            if (key === "totalLatencyMs") {
                assert.equal(
                    typeof child,
                    "number",
                    "executionMetadata.totalLatencyMs must be a number"
                );
                assert.ok(
                    (child as number) >= 0,
                    "executionMetadata.totalLatencyMs must be >= 0"
                );
                out[key] = "<TOTAL_LATENCY>";
            } else {
                out[key] = normalizeMetadataParams(child);
            }
        }
        return out;
    }
    return value;
};

const runScenario = async (
    baseUrl: string,
    scenario: FixtureScenario,
    token: string
): Promise<RawCapture> => {
    ctx.effects = [];
    ctx.processEvents = [];
    ctx.stubs = scenario.stubs ?? {};
    ctx.dbHandler = helper.createScriptedDbQueryHandler(
        scenario.db ?? [],
        record
    );
    ctx.generateLatch = null;
    ctx.queueLatch = null;
    ctx.queuePending = false;
    ctx.queueSettledWaiter = null;
    ctx.shadowInputs = [];

    const transport = scenario.transport ?? "default";
    const watchProcess = transport !== "default";
    if (watchProcess) {
        process.on("uncaughtException", uncaughtHandler);
        process.on("unhandledRejection", rejectionHandler);
    }

    const frames: unknown[] = [];
    const markers: Record<string, unknown> = {};
    let buffer = "";
    let status = 0;
    let headers: http.IncomingHttpHeaders = {};
    let responseEnded = false;
    let requestError: string | null = null;

    const port = Number(new URL(baseUrl).port);
    const capturedAtMs = Date.now();

    try {
        await new Promise<void>((resolve) => {
            const body =
                scenario.request.body && scenario.request.body.kind === "json"
                    ? Buffer.from(
                          JSON.stringify(scenario.request.body.value),
                          "utf8"
                      )
                    : undefined;
            const req = http.request(
                {
                    host: "127.0.0.1",
                    port,
                    method: scenario.request.method,
                    path: scenario.request.path,
                    headers: {
                        origin: helper.FRONTEND_URL,
                        cookie: `${helper.DEV_AUTH_COOKIE}=${token}`,
                        ...(body ? { "content-type": "application/json" } : {}),
                    },
                    timeout: 5000,
                },
                (res) => {
                    status = res.statusCode ?? 0;
                    headers = res.headers;
                    res.setEncoding("utf8");
                    if (transport === "slow-reader") {
                        res.pause();
                        setTimeout(() => res.resume(), 300);
                    }
                    res.on("data", (chunk: string) => {
                        buffer += chunk;
                        let idx: number;
                        while ((idx = buffer.indexOf("\n\n")) >= 0) {
                            const block = buffer.slice(0, idx);
                            buffer = buffer.slice(idx + 2);
                            let frame: unknown;
                            try {
                                frame = parseFrameBlock(block);
                            } catch {
                                frame = { unparseable: block };
                            }
                            if (frame === undefined) continue;
                            frames.push(frame);
                            if (
                                frame &&
                                typeof frame === "object" &&
                                "content" in frame
                            ) {
                                if (
                                    markers.firstContentFrameIndex === undefined
                                ) {
                                    markers.firstContentFrameIndex =
                                        frames.length - 1;
                                }
                                if (ctx.generateLatch) {
                                    markers.generateReleasedByContentFrame =
                                        frames.length - 1;
                                    ctx.generateLatch.resolve();
                                }
                                if (
                                    transport === "destroy-after-first-content"
                                ) {
                                    markers.destroyedAfterFrame =
                                        frames.length - 1;
                                    res.destroy();
                                    req.destroy();
                                }
                            }
                        }
                    });
                    res.on("end", () => {
                        responseEnded = true;
                        markers.queuePendingAtEnd = ctx.queuePending;
                        resolve();
                    });
                    res.on("error", (error) => {
                        requestError = error.message;
                        resolve();
                    });
                    res.on("close", () => {
                        if (!responseEnded) {
                            markers.clientClosedBeforeEnd = true;
                            resolve();
                        }
                    });
                }
            );
            req.on("timeout", () => {
                markers.timedOut = true;
                req.destroy(new Error("request exceeded 5000ms"));
                resolve();
            });
            req.on("error", (error) => {
                requestError = error.message;
                resolve();
            });
            req.on("close", () => {
                if (!responseEnded && frames.length === 0) resolve();
            });
            if (transport === "abort-mid-body" && body) {
                req.write(body.subarray(0, Math.floor(body.length / 2)));
                setTimeout(() => {
                    req.destroy();
                    resolve();
                }, 100);
                return;
            }
            if (body) req.write(body);
            req.end();
        });

        if (transport !== "default") await sleep(400);

        markers.responseEnded = responseEnded;
        if (requestError) markers.requestError = requestError;

        const queueLatch = ctx.queueLatch as Deferred | null;
        const queueSettledWaiter = ctx.queueSettledWaiter as Deferred | null;
        if (queueLatch) {
            const script = ctx.stubs.shadow ?? {};
            markers.enqueuePendingAfterResponseEnd = true;
            if (script.error) {
                queueLatch.reject(new Error(script.error));
            } else {
                queueLatch.resolve();
            }
            if (queueSettledWaiter) {
                await Promise.race([queueSettledWaiter.promise, sleep(2000)]);
            }
        }
    } finally {
        if (watchProcess) {
            process.removeListener("uncaughtException", uncaughtHandler);
            process.removeListener("unhandledRejection", rejectionHandler);
        }
    }

    const outHeaders: Record<string, string | null> = {};
    for (const name of SSE_HEADER_NAMES) {
        const value = headers[name];
        outHeaders[name] = Array.isArray(value)
            ? value.join(", ")
            : (value ?? null);
    }

    const normalizeValue = helper.createValueNormalizer(capturedAtMs);
    return {
        status,
        headers: outHeaders,
        frames,
        effects: normalizeMetadataParams(normalizeValue(ctx.effects)),
        markers,
        processEvents: ctx.processEvents,
        unconsumedDbSteps: ctx.dbHandler?.remainingSteps() ?? 0,
    };
};

let baseUrl = "";
let closeApp: () => Promise<void> = async () => undefined;

const validToken = jwt.sign({ userId: helper.OWNER.id }, helper.JWT_SECRET, {
    expiresIn: "7d",
});

before(async () => {
    const inertExternal = (target: string) =>
        (async () => {
            throw new Error(`Unexpected external call: ${target}`);
        }) as never;

    const testApp = await createTestApp({
        fullStack: true,
        db: fakeDb,
        overrides: [
            {
                token: RATE_LIMIT_CLIENT,
                useValue: {
                    get: () => null,
                    close: async () => undefined,
                },
            },
            {
                token: CHAT_OPERATIONS,
                useValue: createChatOperations(chatDependencies),
            },
            {
                token: START_BOOK_CHAT,
                useValue: createChatOperations(chatDependencies).startBookChat,
            },
            {
                token: APPEND_BOOK_CHAT,
                useValue: createChatOperations(chatDependencies).appendBookChat,
            },
            {
                token: BOOKS_PORTS,
                useValue: {
                    uploadFile: inertExternal("storage.uploadFile"),
                    deleteFile: inertExternal("storage.deleteFile"),
                    deleteVectorCollection: inertExternal(
                        "vectorStore.deleteCollection"
                    ),
                    deleteCollectionChunks: inertExternal(
                        "bookSearchChunks.deleteCollection"
                    ),
                    clearCollectionCache: inertExternal(
                        "hybridBookSearch.clearCollectionCache"
                    ),
                    enqueueBookProcessing: inertExternal(
                        "queue.book-processing.add"
                    ),
                    bookFile: {
                        findBookById: inertExternal("books.findBookById"),
                        getFile: inertExternal("storage.getFile"),
                    },
                },
            },
            {
                token: AUTH_OPERATIONS,
                useValue: {
                    verifyGoogleToken: inertExternal("google.verifyIdToken"),
                    generateToken,
                    getOrCreateDevUser: () =>
                        getOrCreateDevUser(fakeDb as never),
                },
            },
        ],
    });
    baseUrl = testApp.baseUrl;
    closeApp = testApp.close;
});

after(async () => {
    await closeApp();
});

for (const scenario of FIXTURE.scenarios) {
    test(`legacy SSE parity: ${scenario.id}`, async () => {
        const expected = scenario.capture;
        assert.ok(
            !expected.error,
            `reference capture failed: ${expected.error}`
        );

        const actual = await runScenario(baseUrl, scenario, validToken);

        assert.equal(actual.status, expected.status, "status");
        assert.deepEqual(actual.headers, expected.headers, "headers");
        assert.deepEqual(actual.frames, expected.frames, "frames");
        assert.deepEqual(actual.effects, expected.effects, "effects");
        assert.deepEqual(
            actual.processEvents,
            expected.processEvents ?? [],
            "processEvents"
        );
        assert.deepEqual(actual.markers, expected.markers, "markers");
        assert.equal(
            actual.unconsumedDbSteps,
            expected.unconsumedDbSteps ?? 0,
            "unconsumed scripted db steps"
        );
    });
}

test("fixture documents the reference commit", () => {
    assert.equal(FIXTURE.meta.referenceCommit, helper.REFERENCE_COMMIT);
});

test("successful streams persist the assistant message with durable metadata and enqueue the shadow job after end", async () => {
    for (const id of ["chat-create-success", "chat-append-success"]) {
        const scenario = FIXTURE.scenarios.find((s) => s.id === id)!;
        await runScenario(baseUrl, scenario, validToken);

        const inserts = ctx.effects.filter(
            (effect) =>
                effect.type === "db" &&
                effect.operation === "insert" &&
                effect.table === "messages"
        );
        assert.equal(inserts.length, 2, `${id}: expected two message inserts`);
        const userParams = inserts[0].params as unknown[];
        const assistantParams = inserts[1].params as unknown[];
        assert.deepEqual(userParams.slice(0, 3), [
            "conv-1",
            "user",
            "Question?",
        ]);
        assert.equal(assistantParams[0], "conv-1");
        assert.equal(assistantParams[1], "assistant");
        assert.equal(assistantParams[2], "Hello world");
        assert.equal(assistantParams[4], "complete");
        assert.equal(assistantParams[5], "stop");
        const rawMetadata = assistantParams[6];
        const metadata = (
            typeof rawMetadata === "string"
                ? JSON.parse(rawMetadata)
                : rawMetadata
        ) as Record<string, unknown>;
        assert.equal(metadata.modelVersion, "gpt-4o-mini");
        assert.equal(metadata.pipelineVersion, "test-pipeline");
        assert.equal(metadata.promptVersion, "test-prompt");
        assert.equal(
            (metadata.generation as Record<string, unknown>).durationMs,
            7
        );
        assert.equal(
            (metadata.generation as Record<string, unknown>).usage,
            null
        );
        assert.equal(
            (metadata.generation as Record<string, unknown>).estimatedCost,
            null
        );
        assert.equal(metadata.retrievalCost, null);
        assert.equal(metadata.combinedCost, null);
        assert.equal(metadata.pricingVersion, "openai-standard-2026-07-16");
        assert.equal(metadata.langfuseTraceId, null);
        assert.equal(typeof metadata.totalLatencyMs, "number");
        assert.ok((metadata.totalLatencyMs as number) >= 0);

        assert.equal(ctx.shadowInputs.length, 1, `${id}: shadow input`);
        assert.deepEqual(ctx.shadowInputs[0], {
            assistantMessageId: "assistant-msg-1",
            userMessageId: "user-msg-1",
            conversationId: "conv-1",
            bookId: "book-1",
            userId: "owner-1",
            hasHighlightContext: false,
        });
    }
});

test("append replays server history semantics: last 30 rows then the 60000-char budget, client history ignored", async () => {
    const alternating = FIXTURE.scenarios.find(
        (s) => s.id === "chat-append-success"
    )!;
    await runScenario(baseUrl, alternating, validToken);
    let retrieve = ctx.effects.find(
        (effect) => effect.type === "rag" && effect.op === "retrieveBookContext"
    ) as { messages: Array<{ role: string; content: string }> } | undefined;
    assert.ok(retrieve, "retrieveBookContext effect recorded");
    assert.equal(retrieve.messages.length, 31);
    assert.deepEqual(retrieve.messages[0], {
        role: "assistant",
        content: "hist-5",
    });
    assert.deepEqual(retrieve.messages[30], {
        role: "user",
        content: "Question?",
    });

    const bounded = FIXTURE.scenarios.find(
        (s) => s.id === "chat-append-history-char-bound"
    )!;
    await runScenario(baseUrl, bounded, validToken);
    retrieve = ctx.effects.find(
        (effect) => effect.type === "rag" && effect.op === "retrieveBookContext"
    ) as { messages: Array<{ role: string; content: string }> } | undefined;
    assert.ok(retrieve, "retrieveBookContext effect recorded");
    assert.equal(retrieve.messages.length, 15);
    assert.ok(retrieve.messages[0].content.startsWith("hist-21-"));
    assert.deepEqual(retrieve.messages[14], {
        role: "user",
        content: "Question?",
    });
    for (const message of retrieve.messages) {
        assert.notEqual(message.role, "system");
    }
});
