import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";

import * as helper from "./httpParity";
import type {
    RecordedEffect,
    ScriptedDbQueryHandler,
    StubScript,
} from "./httpParity";

const FIXTURE_PATH = process.argv[2];
const OUT_PATH = process.argv[3];
const ENV_NAME = process.argv[4] || process.env.NODE_ENV || "test";

if (!FIXTURE_PATH || !OUT_PATH) {
    console.error(
        "usage: httpParityRunner.js <fixturePath> <outPath> [test|production]"
    );
    process.exit(2);
}

const REQUEST_TIMEOUT_MS = 5000;

const ctx: {
    effects: RecordedEffect[];
    stubs: StubScript;
    dbHandler: ScriptedDbQueryHandler | null;
} = {
    effects: [],
    stubs: {},
    dbHandler: null,
};

const record = (effect: RecordedEffect) => {
    ctx.effects.push(effect);
};

const serializeArg = (value: unknown): unknown => {
    if (Buffer.isBuffer(value)) {
        return { __base64: value.toString("base64") };
    }
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(serializeArg);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = serializeArg(v);
        return out;
    }
    return value === undefined ? null : value;
};

const externalCall = (target: string, detail: Record<string, unknown>) =>
    record({ type: "external", target, ...detail });

const unexpectedCall = (target: string, detail: Record<string, unknown>) => {
    record({ type: "external", target, ...detail, unexpected: true });
    throw new Error(`Unexpected stub call: ${target}`);
};

const scriptedOrThrow = (
    scriptKey: keyof StubScript,
    target: string,
    detail: Record<string, unknown>
) => {
    const script = ctx.stubs ? ctx.stubs[scriptKey] : undefined;
    if (script === undefined) return unexpectedCall(target, detail);
    externalCall(target, detail);
    if (
        script &&
        typeof script === "object" &&
        "error" in script &&
        script.error
    ) {
        throw new Error(String(script.error));
    }
    return script;
};

let uncaughtErrorCount = 0;
process.on("uncaughtException", (error) => {
    uncaughtErrorCount += 1;
    record({
        type: "process",
        event: "uncaughtException",
        message: error && error.message ? error.message : String(error),
    });
    process.exitCode = 1;
});

const sendRequest = (
    port: number,
    built: {
        url: string;
        init: {
            method: string;
            headers: Record<string, string>;
            body?: Buffer;
        };
    }
) =>
    new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
        bodyBytes: Buffer;
    }>((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port,
                method: built.init.method,
                path: built.url,
                headers: built.init.headers,
                timeout: REQUEST_TIMEOUT_MS,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        bodyBytes: Buffer.concat(chunks),
                    })
                );
            }
        );
        req.on("timeout", () =>
            req.destroy(new Error(`request exceeded ${REQUEST_TIMEOUT_MS}ms`))
        );
        req.on("error", reject);
        if (built.init.body) req.write(built.init.body);
        req.end();
    });

const main = async () => {
    process.env.JWT_SECRET = helper.JWT_SECRET;
    process.env.FRONTEND_URL = helper.FRONTEND_URL;
    process.env.GOOGLE_CLIENT_ID = "parity-test-google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "parity-test-google-client-secret";
    process.env.LANGFUSE_SAMPLE_RATE = "0";
    process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:1/test";
    process.env.REDIS_URL = "";
    process.env.DOTENV_CONFIG_PATH = "/dev/null";

    const { drizzle } =
        require("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
    const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken");
    const { createTestApp } =
        require("./nestApp") as typeof import("./nestApp");
    const { GOOGLE_IDENTITY_VERIFIER } =
        require("../../src/auth/auth.tokens") as typeof import("../../src/auth/auth.tokens");
    const { RATE_LIMIT_CLIENT } =
        require("../../src/common/rate-limit.module") as typeof import("../../src/common/rate-limit.module");
    const { BOOKS_PORTS, createBookFileDependencies } =
        require("../../src/books/books.ports") as typeof import("../../src/books/books.ports");
    const {
        CHAT_OPERATIONS,
        createChatOperations,
        defaultChatStreamDependencies,
    } =
        require("../../src/chat/chat-stream") as typeof import("../../src/chat/chat-stream");
    const { APPEND_BOOK_CHAT, START_BOOK_CHAT } =
        require("../../src/infrastructure/chat/chat.tokens") as typeof import("../../src/infrastructure/chat/chat.tokens");

    const client = {
        query: async (queryConfig: unknown, params?: unknown[]) => {
            const sqlText =
                typeof queryConfig === "string"
                    ? queryConfig
                    : (queryConfig as { text?: string } | null | undefined)
                          ?.text;
            if (!ctx.dbHandler) {
                return unexpectedCall("db.query", { sql: sqlText ?? null });
            }
            const result = await ctx.dbHandler(queryConfig, params);
            const columns = helper.extractResultColumns(String(sqlText ?? ""));
            return {
                rows: result.rows.map((row) =>
                    Array.isArray(row)
                        ? row
                        : helper.projectRowToDriverArray(row, columns)
                ),
            };
        },
        connect: async () => client,
        release: () => undefined,
        end: async () => undefined,
    };
    const fakeDb = drizzle(client as never);

    const verifyGoogleTokenStub = async (idToken: string) => {
        if (!idToken) throw new Error("Failed to verify token");
        const detail = {
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        };
        const script = ctx.stubs ? ctx.stubs.google : undefined;
        if (script === undefined || script === "reject") {
            if (script === undefined) {
                return unexpectedCall("google.verifyIdToken", detail);
            }
            externalCall("google.verifyIdToken", detail);
            throw new Error("Scripted Google token rejection");
        }
        externalCall("google.verifyIdToken", detail);
        return {
            sub: script.sub as string,
            email: script.email as string,
            name:
                (script.name as string | undefined) ?? (script.email as string),
            picture: script.picture as string | undefined,
        };
    };

    const getFileStub = async (key: string) => {
        const script = scriptedOrThrow("getFile", "storage.getFile", { key });
        return Buffer.from((script as { base64: string }).base64, "base64");
    };

    const inertExternal = (target: string) =>
        ((...args: unknown[]) =>
            unexpectedCall(target, {
                args: args.map(serializeArg),
            })) as never;

    const booksPorts = {
        uploadFile: async (key: string, file: Buffer) => {
            scriptedOrThrow("uploadFile", "storage.uploadFile", {
                key,
                bytes: file && file.length,
            });
        },
        deleteFile: async (key: string) => {
            scriptedOrThrow("deleteFile", "storage.deleteFile", { key });
        },
        deleteVectorCollection: async (collectionName: string) =>
            unexpectedCall("vectorStore.deleteCollection", { collectionName }),
        deleteCollectionChunks: async (collectionName: string) =>
            unexpectedCall("bookSearchChunks.deleteCollection", {
                collectionName,
            }),
        clearCollectionCache: (collectionName: string) => {
            unexpectedCall("hybridBookSearch.clearCollectionCache", {
                collectionName,
            });
        },
        enqueueBookProcessing: async (payload: unknown) => {
            scriptedOrThrow(
                "enqueueBookProcessing",
                "queue.book-processing.add",
                { payload: serializeArg(payload) }
            );
        },
        bookFile: createBookFileDependencies(fakeDb as never, getFileStub),
    };

    const { DeleteOwnedBook, RetryBookProcessing } =
        require("@reader/application") as typeof import("@reader/application");
    const { createBookCollectionName } =
        require("@reader/processing") as typeof import("@reader/processing");
    const { createDrizzleBookRepository } =
        require("../../src/infrastructure/books/drizzleBookRepository") as typeof import("../../src/infrastructure/books/drizzleBookRepository");
    const { DELETE_OWNED_BOOK, RETRY_BOOK_PROCESSING } =
        require("../../src/books/books.tokens") as typeof import("../../src/books/books.tokens");
    const lifecycleRepository = createDrizzleBookRepository(fakeDb as never);
    const lifecycleLock = {
        withLock: async <T>(
            _bookId: string,
            callback: (signal: AbortSignal) => Promise<T>
        ) => callback(new AbortController().signal),
    };
    const retryBookProcessing = new RetryBookProcessing({
        reads: lifecycleRepository,
        retryState: lifecycleRepository,
        queueState: lifecycleRepository,
        queue: {
            retryOrEnqueue: async (request) => {
                await booksPorts.enqueueBookProcessing(request);
                return "enqueued";
            },
            removePending: async () => {},
        },
        lock: lifecycleLock,
    });
    const deleteOwnedBook = new DeleteOwnedBook({
        reads: lifecycleRepository,
        deletion: lifecycleRepository,
        references: lifecycleRepository,
        cleanup: {
            deleteFile: async (fileKey) => {
                await booksPorts.deleteFile(fileKey);
            },
            deleteVectorCollection: async (collectionName) => {
                await booksPorts.deleteVectorCollection(collectionName);
            },
            deleteSearchChunks: async (collectionName) => {
                await booksPorts.deleteCollectionChunks(collectionName);
            },
            clearCache: (collectionName) =>
                booksPorts.clearCollectionCache(collectionName),
            defaultCollectionName: createBookCollectionName,
        },
        queue: { removePending: async () => {} },
        lock: lifecycleLock,
    });

    const chatOperations = createChatOperations({
        ...defaultChatStreamDependencies,
        db: fakeDb as never,
        retrieveBookContext: inertExternal("chat.retrieveBookContext"),
        generateBookAnswer: inertExternal("chat.generateBookAnswer"),
        maybeEnqueueRagRerankShadow: inertExternal(
            "queue.rag-rerank-shadow.add"
        ),
    });

    const testApp = await createTestApp({
        fullStack: true,
        db: fakeDb,
        overrides: [
            {
                token: GOOGLE_IDENTITY_VERIFIER,
                useValue: { verify: verifyGoogleTokenStub },
            },
            {
                token: RATE_LIMIT_CLIENT,
                useValue: { get: () => null, close: async () => undefined },
            },
            { token: BOOKS_PORTS, useValue: booksPorts },
            { token: RETRY_BOOK_PROCESSING, useValue: retryBookProcessing },
            { token: DELETE_OWNED_BOOK, useValue: deleteOwnedBook },
            { token: CHAT_OPERATIONS, useValue: chatOperations },
            { token: START_BOOK_CHAT, useValue: chatOperations.startBookChat },
            {
                token: APPEND_BOOK_CHAT,
                useValue: chatOperations.appendBookChat,
            },
        ],
    });

    const b64url = (obj: unknown) =>
        Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
    const signManual = (payload: unknown) => {
        const unsigned = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(
            payload
        )}`;
        const sig = crypto
            .createHmac("sha256", helper.JWT_SECRET)
            .update(unsigned)
            .digest("base64url");
        return `${unsigned}.${sig}`;
    };
    const validToken = jwt.sign(
        { userId: helper.OWNER.id },
        helper.JWT_SECRET,
        { expiresIn: `${helper.AUTH_COOKIE_MAX_AGE_SECONDS}s` }
    );
    const expiredToken = signManual({
        userId: helper.OWNER.id,
        iat: 1,
        exp: 1,
    });
    const tamperedToken = (() => {
        const parts = validToken.split(".");
        const sig = parts[2];
        const flipped = (sig.startsWith("A") ? "B" : "A") + sig.slice(1);
        return `${parts[0]}.${parts[1]}.${flipped}`;
    })();
    const tokens = {
        valid: validToken,
        expired: expiredToken,
        tampered: tamperedToken,
    };

    const port = Number(new URL(testApp.baseUrl).port);
    const etagByScenario = new Map<string, string>();
    const resolveEtag = (id: string) => etagByScenario.get(id);

    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
        scenarios: helper.HttpParityScenario[];
    };
    const scenarios = fixture.scenarios.filter(
        (scenario) => scenario.env === ENV_NAME
    );

    const results: Record<string, unknown>[] = [];
    try {
        for (const scenario of scenarios) {
            ctx.effects = [];
            ctx.stubs = scenario.stubs ? { ...scenario.stubs } : {};
            ctx.dbHandler = helper.createScriptedDbQueryHandler(
                scenario.db ?? [],
                record
            );
            const entry: Record<string, unknown> = {
                id: scenario.id,
                env: scenario.env,
                ...(scenario.intentionalDifference
                    ? { intentionalDifference: scenario.intentionalDifference }
                    : {}),
            };
            try {
                const built = helper.buildScenarioRequest(
                    scenario,
                    tokens,
                    resolveEtag
                );
                const res = await sendRequest(port, built);
                await new Promise<void>((resolve) => setImmediate(resolve));
                const capturedAtMs = Date.now();
                const headers = res.headers;
                const etag = headers["etag"];
                if (typeof etag === "string") {
                    etagByScenario.set(scenario.id, etag);
                }
                const setCookie = headers["set-cookie"];
                const cookies = Array.isArray(setCookie)
                    ? setCookie
                    : setCookie
                      ? [setCookie]
                      : [];
                entry.capture = helper.buildCapture({
                    id: scenario.id,
                    status: res.status,
                    headerValue: (name) => {
                        const value = headers[name];
                        if (Array.isArray(value)) return value.join(", ");
                        return value === undefined ? null : value;
                    },
                    cookies,
                    contentType:
                        typeof headers["content-type"] === "string"
                            ? headers["content-type"]
                            : null,
                    bodyBytes: res.bodyBytes,
                    effects: ctx.effects,
                    capturedAtMs,
                });
                const remaining = ctx.dbHandler.remainingSteps();
                if (remaining > 0) {
                    entry.unconsumedDbSteps = remaining;
                }
            } catch (error) {
                entry.error = String(
                    error && (error as Error).stack
                        ? (error as Error).stack
                        : error
                );
                entry.effects = ctx.effects;
            }
            results.push(entry);
        }
    } finally {
        await testApp.close();
    }

    fs.writeFileSync(
        OUT_PATH,
        JSON.stringify({ nodeEnv: ENV_NAME, results }, null, 2)
    );
};

main().then(
    () => process.exit(uncaughtErrorCount ? 1 : 0),
    (error) => {
        console.error(error && error.stack ? error.stack : error);
        process.exit(1);
    }
);
