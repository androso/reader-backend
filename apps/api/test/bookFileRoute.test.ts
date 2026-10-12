import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { Request, Response } from "express";
import { handleGetBookFile } from "../src/books/book-file.handler";
import type { RecordedEffect } from "./helpers/httpParity";
import type { BooksPorts } from "../src/books/books.ports";
import { StoredBookFileNotFoundError } from "@reader/application";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";
process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:1/test";
process.env.REDIS_URL = "";
process.env.LANGFUSE_SAMPLE_RATE = "0";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { drizzle } =
    require("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken");
const { BooksController } =
    require("../src/books/books.controller") as typeof import("../src/books/books.controller");
const { DRIZZLE } =
    require("../src/database/database.module") as typeof import("../src/database/database.module");
const { BOOKS_PORTS, createBookFileDependencies } =
    require("../src/books/books.ports") as typeof import("../src/books/books.ports");
const { BOOKS_USE_CASE_PROVIDERS } =
    require("../src/books/books.module") as typeof import("../src/books/books.module");
const { RATE_LIMIT_CLIENT } =
    require("../src/common/rate-limit.module") as typeof import("../src/common/rate-limit.module");
const { createTestApp } =
    require("./helpers/nestApp") as typeof import("./helpers/nestApp");
const helper =
    require("./helpers/httpParity") as typeof import("./helpers/httpParity");

const AUTH_COOKIE = `reader_session=${jwt.sign(
    { userId: helper.OWNER.id },
    helper.JWT_SECRET
)}`;
const FILE_BYTES = Buffer.from("%PDF-synthetic\n", "utf8");

const requestRaw = (
    url: string,
    headers: http.OutgoingHttpHeaders
): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}> =>
    new Promise((resolve, reject) => {
        const req = http.get(url, { headers }, (res) => {
            const received: Buffer[] = [];
            res.on("data", (chunk: Buffer) => received.push(chunk));
            res.on("end", () =>
                resolve({
                    status: res.statusCode ?? 0,
                    headers: res.headers,
                    body: Buffer.concat(received),
                })
            );
        });
        req.on("error", reject);
    });

type ScriptedStep = {
    op: "select" | "insert" | "update" | "delete";
    table?: string;
    rows?: Record<string, unknown>[];
    error?: string;
};

const createScriptedDb = (steps: ScriptedStep[]) => {
    const effects: RecordedEffect[] = [];
    const queue = [...steps];
    const client = {
        async query(queryConfig: unknown, params?: unknown[]) {
            const sqlText =
                typeof queryConfig === "string"
                    ? queryConfig
                    : ((queryConfig as { text?: string } | null | undefined)
                          ?.text ?? "");
            const { op, table } = helper.classifyDbQuery(sqlText);
            const effect: RecordedEffect = {
                type: "db",
                operation: op,
                sql: sqlText,
                params: helper.serializeParams(params),
                ...(table ? { table } : {}),
            };
            const step = queue.shift();
            if (!step) {
                effects.push({ ...effect, unexpected: true });
                throw new Error(`Unscripted db query: ${sqlText}`);
            }
            if (step.op !== op || (step.table && step.table !== table)) {
                effects.push({
                    ...effect,
                    unexpected: true,
                    expected: { op: step.op, table: step.table },
                });
                throw new Error(
                    `Scripted db mismatch: expected ${step.op} ${
                        step.table ?? "*"
                    }, got ${op} ${table ?? "*"} :: ${sqlText}`
                );
            }
            if (step.error) {
                effects.push({ ...effect, error: step.error });
                throw new Error(step.error);
            }
            effects.push(effect);
            const columns = helper.extractResultColumns(sqlText);
            return {
                rows: (step.rows ?? []).map((row) =>
                    helper.projectRowToDriverArray(row, columns)
                ),
            };
        },
        connect: async () => client,
        release: () => undefined,
        end: async () => undefined,
    };
    return {
        db: drizzle(client as never),
        effects,
        remaining: () => queue.length,
    };
};

const authUser: ScriptedStep = {
    op: "select",
    table: "users",
    rows: [helper.OWNER_ROW],
};

const bookById = (row: Record<string, unknown>): ScriptedStep => ({
    op: "select",
    table: "books",
    rows: [row],
});

const emptyBookSelect: ScriptedStep = {
    op: "select",
    table: "books",
    rows: [],
};

const assertScriptedDbComplete = (scripted: {
    remaining(): number;
    effects: RecordedEffect[];
}) => {
    assert.deepEqual(
        scripted.effects.filter((effect) => effect.unexpected === true),
        []
    );
    assert.equal(scripted.remaining(), 0);
};

const createFileRouteTestApp = (
    scripted: { db: unknown },
    readFile: (fileKey: string) => Promise<Buffer>
) => {
    const never = (target: string) => async () => {
        throw new Error(`unexpected call: ${target}`);
    };
    const ports = {
        uploadFile: never("storage.uploadFile"),
        deleteFile: never("storage.deleteFile"),
        deleteVectorCollection: never("vectorStore.deleteCollection"),
        deleteCollectionChunks: never("bookSearchChunks.deleteCollection"),
        clearCollectionCache: (collectionName: string) => {
            throw new Error(
                `unexpected call: hybridBookSearch.clearCollectionCache ${collectionName}`
            );
        },
        enqueueBookProcessing: never("queue.book-processing.add"),
        bookFile: createBookFileDependencies(scripted.db as never, readFile),
    } as unknown as BooksPorts;
    return createTestApp({
        controllers: [BooksController],
        providers: [
            ...BOOKS_USE_CASE_PROVIDERS,
            { provide: DRIZZLE, useValue: scripted.db },
            { provide: BOOKS_PORTS, useValue: ports },
            {
                provide: RATE_LIMIT_CLIENT,
                useValue: { get: () => null, close: async () => {} },
            },
        ],
    });
};

type TestResponse = {
    statusCode: number;
    body?: unknown;
    contentType?: string;
    headers: Record<string, string>;
    sent?: unknown;
    status(code: number): TestResponse;
    json(payload: unknown): TestResponse;
    type(contentType: string): TestResponse;
    send(payload: unknown): TestResponse;
    setHeader(name: string, value: string): TestResponse;
};

const createResponse = (): TestResponse => {
    const res: TestResponse = {
        statusCode: 200,
        headers: {},
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(payload: unknown) {
            this.body = payload;
            return this;
        },
        type(contentType: string) {
            this.contentType = contentType;
            return this;
        },
        send(payload: unknown) {
            this.sent = payload;
            return this;
        },
        setHeader(name: string, value: string) {
            this.headers[name] = value;
            return this;
        },
    };

    return res;
};

const createRequest = (bookId: string, userId: string) =>
    ({
        params: { id: bookId },
        user: { id: userId },
    }) as unknown as Request;

test("fetches an owned book file by the book row's file key", async () => {
    const calls: string[] = [];
    const res = createResponse();
    const fileBuffer = Buffer.from("owned book");

    await handleGetBookFile(
        createRequest("book-1", "user-1"),
        res as unknown as Response,
        {
            async findBookById(bookId) {
                assert.equal(bookId, "book-1");
                return {
                    id: "book-1",
                    userId: "user-1",
                    fileKey: "epub-storage-key",
                    fileType: "epub",
                };
            },
            async getFile(fileKey) {
                calls.push(fileKey);
                return fileBuffer;
            },
        }
    );

    assert.deepEqual(calls, ["epub-storage-key"]);
    assert.equal(res.statusCode, 200);
    assert.equal(res.contentType, "application/epub+zip");
    assert.equal(res.headers["Cache-Control"], "private");
    assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(res.sent, fileBuffer);
});

test("rejects a non-owner before reading storage", async () => {
    const calls: string[] = [];
    const res = createResponse();

    await handleGetBookFile(
        createRequest("book-1", "user-2"),
        res as unknown as Response,
        {
            async findBookById() {
                return {
                    id: "book-1",
                    userId: "user-1",
                    fileKey: "epub-storage-key",
                    fileType: "epub",
                };
            },
            async getFile(fileKey) {
                calls.push(fileKey);
                return Buffer.from("should not be read");
            },
        }
    );

    assert.deepEqual(calls, []);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "Not authorized" });
});

test("returns not found for a missing book before reading storage", async () => {
    const calls: string[] = [];
    const res = createResponse();

    await handleGetBookFile(
        createRequest("missing-book", "user-1"),
        res as unknown as Response,
        {
            async findBookById(bookId) {
                assert.equal(bookId, "missing-book");
                return undefined;
            },
            async getFile(fileKey) {
                calls.push(fileKey);
                return Buffer.from("should not be read");
            },
        }
    );

    assert.deepEqual(calls, []);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: "Book was not found" });
});

test("GET /api/books/:id serves a pdf over the real Nest route", async () => {
    const scripted = createScriptedDb([authUser, bookById(helper.BOOK_ROW)]);
    const testApp = await createFileRouteTestApp(scripted, async (fileKey) => {
        scripted.effects.push({
            type: "external",
            target: "storage.getFile",
            key: fileKey,
        });
        return FILE_BYTES;
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1`, {
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "application/pdf");
        assert.equal(res.headers.get("cache-control"), "private");
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
        assert.ok(res.headers.get("etag"));
        assert.ok(Buffer.from(await res.arrayBuffer()).equals(FILE_BYTES));
        const select = scripted.effects.find(
            (effect) =>
                effect.operation === "select" && effect.table === "books"
        );
        assert.equal(select?.operation, "select");
        assert.equal(select?.table, "books");
        assert.deepEqual(select?.params, ["book-1"]);
        assert.equal(scripted.effects.at(-1)?.target, "storage.getFile");
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("GET /api/books/:id serves an epub with the epub content type", async () => {
    const scripted = createScriptedDb([
        authUser,
        bookById(helper.EPUB_BOOK_ROW),
    ]);
    const testApp = await createFileRouteTestApp(scripted, async (fileKey) => {
        scripted.effects.push({
            type: "external",
            target: "storage.getFile",
            key: fileKey,
        });
        return FILE_BYTES;
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1`, {
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "application/epub+zip");
        assert.equal(res.headers.get("cache-control"), "private");
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
        assert.ok(Buffer.from(await res.arrayBuffer()).equals(FILE_BYTES));
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("GET /api/books/:id serves a null fileType as octet-stream", async () => {
    const scripted = createScriptedDb([
        authUser,
        bookById(helper.NULL_FILE_TYPE_BOOK_ROW),
    ]);
    const testApp = await createFileRouteTestApp(scripted, async (fileKey) => {
        scripted.effects.push({
            type: "external",
            target: "storage.getFile",
            key: fileKey,
        });
        return FILE_BYTES;
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1`, {
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 200);
        assert.equal(
            res.headers.get("content-type"),
            "application/octet-stream"
        );
        assert.ok(Buffer.from(await res.arrayBuffer()).equals(FILE_BYTES));
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("GET /api/books/:id returns 404 for a missing book without a storage read", async () => {
    const scripted = createScriptedDb([authUser, emptyBookSelect]);
    const testApp = await createFileRouteTestApp(scripted, async (fileKey) => {
        scripted.effects.push({
            type: "external",
            target: "storage.getFile",
            key: fileKey,
        });
        return FILE_BYTES;
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/missing-book`, {
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: "Book was not found" });
        assert.ok(
            !scripted.effects.some(
                (effect) => effect.target === "storage.getFile"
            )
        );
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("GET /api/books/:id returns 403 for a non-owner without a storage read", async () => {
    const scripted = createScriptedDb([
        authUser,
        bookById(helper.OTHER_OWNER_BOOK_ROW),
    ]);
    const testApp = await createFileRouteTestApp(scripted, async (fileKey) => {
        scripted.effects.push({
            type: "external",
            target: "storage.getFile",
            key: fileKey,
        });
        return FILE_BYTES;
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1`, {
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 403);
        assert.deepEqual(await res.json(), { error: "Not authorized" });
        assert.ok(
            !scripted.effects.some(
                (effect) => effect.target === "storage.getFile"
            )
        );
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("GET /api/books/:id returns 500 when storage fails", async () => {
    const scripted = createScriptedDb([authUser, bookById(helper.BOOK_ROW)]);
    const testApp = await createFileRouteTestApp(scripted, async (fileKey) => {
        scripted.effects.push({
            type: "external",
            target: "storage.getFile",
            key: fileKey,
        });
        throw new Error("storage backend unavailable");
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1`, {
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), {
            error: "Internal server error",
        });
        assert.ok(
            scripted.effects.some(
                (effect) => effect.target === "storage.getFile"
            )
        );
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("GET /api/books/:id returns an actionable 404 when the original is missing", async () => {
    const scripted = createScriptedDb([authUser, bookById(helper.BOOK_ROW)]);
    const testApp = await createFileRouteTestApp(scripted, async () => {
        throw new StoredBookFileNotFoundError();
    });
    try {
        const response = await fetch(`${testApp.baseUrl}/api/books/book-1`, {
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), {
            error: "Book file is missing from storage. Restore the original file or upload the book again.",
            code: "BOOK_FILE_MISSING",
        });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("GET /api/books/:id does not read a deleting book's file", async () => {
    const scripted = createScriptedDb([
        authUser,
        bookById({ ...helper.BOOK_ROW, processing_status: "deleting" }),
    ]);
    let reads = 0;
    const testApp = await createFileRouteTestApp(scripted, async () => {
        reads += 1;
        throw new StoredBookFileNotFoundError();
    });
    try {
        const response = await fetch(`${testApp.baseUrl}/api/books/book-1`, {
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), {
            error: "Book was not found",
        });
        assert.equal(reads, 0);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("compatibility file handler reports missing storage without a 500", async () => {
    const response = createResponse();
    await handleGetBookFile(
        createRequest("book-1", "user-1"),
        response as unknown as Response,
        {
            findBookById: async () => ({
                id: "book-1",
                userId: "user-1",
                fileKey: "missing-original",
                fileType: "epub",
            }),
            getFile: async () => {
                throw new StoredBookFileNotFoundError();
            },
        }
    );
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, {
        error: "Book file is missing from storage. Restore the original file or upload the book again.",
        code: "BOOK_FILE_MISSING",
    });
});

test("HEAD /api/books/:id returns the file headers without a body", async () => {
    const scripted = createScriptedDb([authUser, bookById(helper.BOOK_ROW)]);
    const testApp = await createFileRouteTestApp(scripted, async (fileKey) => {
        scripted.effects.push({
            type: "external",
            target: "storage.getFile",
            key: fileKey,
        });
        return FILE_BYTES;
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1`, {
            method: "HEAD",
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "application/pdf");
        assert.equal(res.headers.get("cache-control"), "private");
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
        assert.equal((await res.arrayBuffer()).byteLength, 0);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("GET /api/books/:id returns 304 when If-None-Match matches the ETag", async () => {
    const scripted = createScriptedDb([
        authUser,
        bookById(helper.BOOK_ROW),
        authUser,
        bookById(helper.BOOK_ROW),
    ]);
    const testApp = await createFileRouteTestApp(scripted, async (fileKey) => {
        scripted.effects.push({
            type: "external",
            target: "storage.getFile",
            key: fileKey,
        });
        return FILE_BYTES;
    });
    try {
        const first = await fetch(`${testApp.baseUrl}/api/books/book-1`, {
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(first.status, 200);
        const etag = first.headers.get("etag");
        assert.ok(etag);
        await first.arrayBuffer();

        const res = await requestRaw(`${testApp.baseUrl}/api/books/book-1`, {
            cookie: AUTH_COOKIE,
            "if-none-match": etag!,
        });
        assert.equal(res.status, 304);
        assert.equal(res.headers["cache-control"], "private");
        assert.equal(res.headers["x-content-type-options"], "nosniff");
        assert.equal(res.headers["content-type"], undefined);
        assert.equal(res.body.length, 0);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});
