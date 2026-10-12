import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import JSZip from "jszip";
import type { MultipartPart, RecordedEffect } from "./helpers/httpParity";
import type { BooksPorts } from "../src/books/books.ports";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";
process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";
process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:1/test";
process.env.REDIS_URL = "";
process.env.LANGFUSE_SAMPLE_RATE = "0";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { drizzle } =
    require("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken");
const { BooksController } =
    require("../src/books/books.controller") as typeof import("../src/books/books.controller");
const { DRIZZLE, DatabaseModule } =
    require("../src/database/database.module") as typeof import("../src/database/database.module");
const { BOOKS_PORTS } =
    require("../src/books/books.ports") as typeof import("../src/books/books.ports");
const { DELETE_OWNED_BOOK, RETRY_BOOK_PROCESSING } =
    require("../src/books/books.tokens") as typeof import("../src/books/books.tokens");
const { DeleteOwnedBook, RetryBookProcessing } =
    require("@reader/application") as typeof import("@reader/application");
const { createDrizzleBookRepository } =
    require("../src/infrastructure/books/drizzleBookRepository") as typeof import("../src/infrastructure/books/drizzleBookRepository");
const { BooksModule, BOOKS_USE_CASE_PROVIDERS } =
    require("../src/books/books.module") as typeof import("../src/books/books.module");
const { createBookProcessingEnqueueRepository, handleBookProcessingEnqueue } =
    require("../src/services/BookProcessingEnqueueService") as typeof import("../src/services/BookProcessingEnqueueService");
const { Books } =
    require("../src/db/schema") as typeof import("../src/db/schema");
const { RATE_LIMIT_CLIENT, RateLimitModule } =
    require("../src/common/rate-limit.module") as typeof import("../src/common/rate-limit.module");
const { createTestApp } =
    require("./helpers/nestApp") as typeof import("./helpers/nestApp");
const helper =
    require("./helpers/httpParity") as typeof import("./helpers/httpParity");
const { BookLifecycleLockTimeoutError } =
    require("@reader/domain") as typeof import("@reader/domain");

const INERT_RATE_LIMIT = { get: () => null, close: async () => {} };
const AUTH_COOKIE = `reader_session=${jwt.sign(
    { userId: helper.OWNER.id },
    helper.JWT_SECRET
)}`;
const TRUSTED_ORIGIN = helper.FRONTEND_URL;
const PDF_BYTES = Buffer.from("%PDF-synthetic\n", "utf8");
const BOOK_SELECT_BY_ID_SQL =
    'select "id", "title", "user_id", "file_key", "file_type", "collection_name", "processing_status", "processing_error", "created_at" from "books" where "books"."id" = $1';

const createEpubBytes = () => {
    const zip = new JSZip();
    zip.file("META-INF/container.xml", "<container />");
    return zip.generateAsync({ type: "nodebuffer" });
};

const createPlainZipBytes = () => {
    const zip = new JSZip();
    zip.file("file.txt", "not an epub");
    return zip.generateAsync({ type: "nodebuffer" });
};

type ScriptedStep = {
    op: "select" | "insert" | "update" | "delete";
    table?: string;
    rows?:
        | Record<string, unknown>[]
        | ((params: unknown[]) => Record<string, unknown>[]);
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
            const rows =
                typeof step.rows === "function"
                    ? step.rows(helper.serializeParams(params))
                    : (step.rows ?? []);
            const columns = helper.extractResultColumns(sqlText);
            return {
                rows: rows.map((row) =>
                    helper.projectRowToDriverArray(row, columns)
                ),
            };
        },
        connect: async () => client,
        release: () => undefined,
        end: async () => undefined,
    };
    const database = drizzle(client as never);
    (database as any).transaction = async (
        callback: (transaction: unknown) => unknown
    ) => callback(database);
    return {
        db: database,
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

const BOOK_ROW = helper.BOOK_ROW;
const OTHER_OWNER_BOOK_ROW = helper.OTHER_OWNER_BOOK_ROW;
const FAILED_BOOK_ROW: Record<string, unknown> = {
    ...BOOK_ROW,
    processing_status: "failed",
    processing_error: "previous failure",
};
const QUEUE_FAILED_BOOK_ROW: Record<string, unknown> = {
    ...BOOK_ROW,
    processing_status: "queue_failed",
    processing_error: "Book processing queue unavailable: queue down",
};
const READY_NO_COLLECTION_BOOK_ROW: Record<string, unknown> = {
    ...BOOK_ROW,
    collection_name: null,
};
const NULL_COLLECTION_BOOK_ROW: Record<string, unknown> = {
    ...BOOK_ROW,
    collection_name: null,
};

const deleteSuccessfulSteps = (
    book: Record<string, unknown>,
    fileReferences = 0,
    collectionReferences = 0
): ScriptedStep[] => [
    authUser,
    bookById(book),
    { op: "update", table: "books", rows: [{ id: book.id }] },
    bookById(book),
    { op: "select", table: "books", rows: [{ count: fileReferences }] },
    { op: "select", table: "books", rows: [{ count: collectionReferences }] },
    { op: "delete", table: "books", rows: [{ id: book.id }] },
    { op: "delete", table: "conversations" },
];

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

const effectNames = (effects: RecordedEffect[]) =>
    effects.map((effect) =>
        effect.type === "db"
            ? `db.${String(effect.operation)} ${String(
                  effect.table ?? ""
              )}`.trim()
            : String(effect.target)
    );

const createPorts = (
    effects: RecordedEffect[],
    overrides: Record<string, unknown> = {}
) =>
    ({
        uploadFile: async (key: string, file: Buffer) => {
            effects.push({
                type: "external",
                target: "storage.uploadFile",
                key,
                bytes: file.length,
                file,
            });
        },
        deleteFile: async (key: string) => {
            effects.push({
                type: "external",
                target: "storage.deleteFile",
                key,
            });
        },
        deleteVectorCollection: async (collectionName: string) => {
            effects.push({
                type: "external",
                target: "vectorStore.deleteCollection",
                collectionName,
            });
        },
        deleteCollectionChunks: async (collectionName: string) => {
            effects.push({
                type: "external",
                target: "bookSearchChunks.deleteCollection",
                collectionName,
            });
        },
        clearCollectionCache: (collectionName: string) => {
            effects.push({
                type: "external",
                target: "hybridBookSearch.clearCollectionCache",
                collectionName,
            });
        },
        enqueueBookProcessing: async (payload: unknown) => {
            effects.push({
                type: "external",
                target: "queue.book-processing.add",
                payload,
            });
        },
        bookFile: {
            findBookById: async () => {
                throw new Error("unexpected findBookById call");
            },
            getFile: async () => {
                throw new Error("unexpected getFile call");
            },
        },
        ...overrides,
    }) as unknown as BooksPorts;

const createBooksTestApp = (
    scripted: { db: unknown },
    ports: BooksPorts,
    retryLock?: {
        withLock<T>(
            bookId: string,
            fn: (signal: AbortSignal) => Promise<T>
        ): Promise<T>;
    }
) =>
    createTestApp({
        controllers: [BooksController],
        providers: [
            ...BOOKS_USE_CASE_PROVIDERS,
            {
                provide: RETRY_BOOK_PROCESSING,
                useFactory: (database: unknown, testPorts: BooksPorts) => {
                    const repository = createDrizzleBookRepository(
                        database as never
                    );
                    return new RetryBookProcessing({
                        reads: repository,
                        retryState: repository,
                        queueState: repository,
                        queue: {
                            retryOrEnqueue: async (request) => {
                                await testPorts.enqueueBookProcessing(request);
                                return "enqueued";
                            },
                            removePending: async () => {},
                        },
                        lock: retryLock ?? {
                            withLock: async (_bookId, fn) =>
                                fn(new AbortController().signal),
                        },
                    });
                },
                inject: [DRIZZLE, BOOKS_PORTS],
            },
            {
                provide: DELETE_OWNED_BOOK,
                useFactory: (database: unknown, testPorts: BooksPorts) => {
                    const repository = createDrizzleBookRepository(
                        database as never
                    );
                    return new DeleteOwnedBook({
                        reads: repository,
                        deletion: repository,
                        references: repository,
                        cleanup: {
                            deleteFile: async (fileKey) => {
                                await testPorts.deleteFile(fileKey);
                            },
                            deleteVectorCollection: async (collectionName) => {
                                await testPorts.deleteVectorCollection(
                                    collectionName
                                );
                            },
                            deleteSearchChunks:
                                testPorts.deleteCollectionChunks,
                            clearCache: testPorts.clearCollectionCache,
                            defaultCollectionName: (bookId) =>
                                `book_${bookId.replace(/-/g, "_")}`,
                        },
                        queue: { removePending: async () => {} },
                        lock: {
                            withLock: async (_bookId, fn) =>
                                fn(new AbortController().signal),
                        },
                    });
                },
                inject: [DRIZZLE, BOOKS_PORTS],
            },
            { provide: DRIZZLE, useValue: scripted.db },
            { provide: BOOKS_PORTS, useValue: ports },
            { provide: RATE_LIMIT_CLIENT, useValue: INERT_RATE_LIMIT },
        ],
    });

const createFullStackBooksApp = (
    scripted: { db: unknown },
    ports: BooksPorts
) =>
    createTestApp({
        fullStack: true,
        imports: [DatabaseModule, RateLimitModule, BooksModule],
        db: scripted.db,
        overrides: [
            { token: RATE_LIMIT_CLIENT, useValue: INERT_RATE_LIMIT },
            { token: BOOKS_PORTS, useValue: ports },
        ],
    });

const postBooksUpload = (
    baseUrl: string,
    options: {
        parts?: MultipartPart[];
        truncateAt?: number;
        cookie?: string;
        origin?: string;
    } = {}
) => {
    const headers: Record<string, string> = {};
    if (options.cookie) headers.cookie = options.cookie;
    if (options.origin) headers.origin = options.origin;
    let body: Buffer | undefined;
    if (options.parts) {
        const built = helper.buildMultipartBody(
            options.parts,
            options.truncateAt
        );
        body = built.body;
        headers["content-type"] = built.contentType;
    }
    return fetch(`${baseUrl}/api/books`, { method: "POST", headers, body });
};

const sendRaw = (
    baseUrl: string,
    request: {
        path: string;
        headers: Record<string, string>;
        chunks: Iterable<Buffer>;
    }
): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}> =>
    new Promise((resolve, reject) => {
        const url = new URL(baseUrl);
        const req = http.request(
            {
                host: url.hostname,
                port: url.port,
                method: "POST",
                path: request.path,
                headers: request.headers,
            },
            (res) => {
                const received: Buffer[] = [];
                res.on("data", (chunk: Buffer) => received.push(chunk));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body: Buffer.concat(received),
                    })
                );
            }
        );
        req.setTimeout(60_000, () =>
            req.destroy(new Error("raw request timeout"))
        );
        let failed = false;
        req.on("error", (error) => {
            if (!failed) {
                failed = true;
                reject(error);
            }
        });
        void (async () => {
            try {
                for (const chunk of request.chunks) {
                    if (chunk.length && !req.write(chunk)) {
                        await once(req, "drain");
                    }
                }
                req.end();
            } catch (error) {
                if (!failed) {
                    failed = true;
                    reject(error);
                }
            }
        })();
    });

test("POST /api/books without a file returns 400", async () => {
    const scripted = createScriptedDb([authUser]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await postBooksUpload(testApp.baseUrl, {
            cookie: AUTH_COOKIE,
        });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "No file uploaded" });
        assert.deepEqual(effectNames(scripted.effects), ["db.select users"]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books with only a field part returns 400", async () => {
    const scripted = createScriptedDb([authUser]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await postBooksUpload(testApp.baseUrl, {
            cookie: AUTH_COOKIE,
            parts: [{ name: "title", text: "no file here" }],
        });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "No file uploaded" });
        assert.deepEqual(effectNames(scripted.effects), ["db.select users"]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books rejects an unauthenticated upload before storage or queue", async () => {
    const scripted = createScriptedDb([]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await postBooksUpload(testApp.baseUrl, {
            parts: [
                {
                    name: "file",
                    filename: "Example.pdf",
                    contentType: "application/pdf",
                    base64: PDF_BYTES.toString("base64"),
                },
            ],
        });
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { message: "No token provided" });
        assert.deepEqual(scripted.effects, []);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books rejects a file that is not a PDF or EPUB", async () => {
    const scripted = createScriptedDb([authUser]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await postBooksUpload(testApp.baseUrl, {
            cookie: AUTH_COOKIE,
            parts: [
                {
                    name: "file",
                    filename: "notabook.bin",
                    contentType: "application/octet-stream",
                    text: "this is not a pdf or epub",
                },
            ],
        });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), {
            error: "Invalid PDF or EPUB file",
        });
        assert.deepEqual(effectNames(scripted.effects), ["db.select users"]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books rejects a zip archive that is not an EPUB", async () => {
    const scripted = createScriptedDb([authUser]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await postBooksUpload(testApp.baseUrl, {
            cookie: AUTH_COOKIE,
            parts: [
                {
                    name: "file",
                    filename: "archive.zip",
                    contentType: "application/zip",
                    base64: (await createPlainZipBytes()).toString("base64"),
                },
            ],
        });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), {
            error: "Invalid PDF or EPUB file",
        });
        assert.deepEqual(effectNames(scripted.effects), ["db.select users"]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books accepts a real PDF and pipelines storage, insert, queue, re-read", async () => {
    let insertedRow: Record<string, unknown> | undefined;
    const scripted = createScriptedDb([
        authUser,
        {
            op: "insert",
            table: "books",
            rows: (params) => {
                insertedRow = {
                    id: params[0],
                    title: params[1],
                    user_id: params[2],
                    file_key: params[3],
                    file_type: params[4],
                    collection_name: null,
                    processing_status: params[5],
                    processing_error: params[6],
                    created_at: "2024-01-01 00:00:00",
                };
                return [insertedRow];
            },
        },
        { op: "select", table: "books", rows: () => [insertedRow!] },
    ]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await postBooksUpload(testApp.baseUrl, {
            cookie: AUTH_COOKIE,
            parts: [
                {
                    name: "file",
                    filename: "Example.pdf",
                    contentType: "application/pdf",
                    base64: PDF_BYTES.toString("base64"),
                },
            ],
        });
        assert.equal(res.status, 202);
        const body = await res.json();
        const effects = scripted.effects;
        const upload = effects.find(
            (effect) => effect.target === "storage.uploadFile"
        );
        const insert = effects.find((effect) => effect.operation === "insert");
        const queued = effects.find(
            (effect) => effect.target === "queue.book-processing.add"
        );
        const reread = effects[effects.length - 1];
        assert.ok(upload && insert && queued);
        const bookId = (insert.params as unknown[])[0] as string;
        assert.match(
            bookId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
        const fileKey = `users/owner-1/books/${bookId}/original`;
        assert.equal(upload.key, fileKey);
        assert.ok((upload.file as Buffer).equals(PDF_BYTES));
        assert.equal(upload.bytes, PDF_BYTES.length);
        assert.deepEqual(insert.params, [
            bookId,
            "Example.pdf",
            "owner-1",
            fileKey,
            "pdf",
            "processing",
            null,
        ]);
        assert.deepEqual(queued.payload, {
            bookId,
            userId: "owner-1",
            fileKey,
            fileType: "pdf",
        });
        assert.equal(reread.type, "db");
        assert.equal(reread.operation, "select");
        assert.deepEqual(reread.params, [bookId]);
        assert.deepEqual(body, {
            message: "File upload accepted for processing",
            book: {
                id: bookId,
                title: "Example.pdf",
                userId: "owner-1",
                fileKey,
                fileType: "pdf",
                collectionName: null,
                processingStatus: "processing",
                processingError: null,
                createdAt: "2024-01-01T00:00:00.000Z",
            },
            processStatus: "processing",
            fileType: "application/pdf",
        });
        assert.deepEqual(effectNames(effects), [
            "db.select users",
            "storage.uploadFile",
            "db.insert books",
            "queue.book-processing.add",
            "db.select books",
        ]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books accepts a real EPUB container", async () => {
    let insertedRow: Record<string, unknown> | undefined;
    const scripted = createScriptedDb([
        authUser,
        {
            op: "insert",
            table: "books",
            rows: (params) => {
                insertedRow = {
                    id: params[0],
                    title: params[1],
                    user_id: params[2],
                    file_key: params[3],
                    file_type: params[4],
                    collection_name: null,
                    processing_status: params[5],
                    processing_error: params[6],
                    created_at: "2024-01-01 00:00:00",
                };
                return [insertedRow];
            },
        },
        { op: "select", table: "books", rows: () => [insertedRow!] },
    ]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await postBooksUpload(testApp.baseUrl, {
            cookie: AUTH_COOKIE,
            parts: [
                {
                    name: "file",
                    filename: "Example.epub",
                    contentType: "application/epub+zip",
                    base64: (await createEpubBytes()).toString("base64"),
                },
            ],
        });
        assert.equal(res.status, 202);
        const body = await res.json();
        const insert = scripted.effects.find(
            (effect) => effect.operation === "insert"
        );
        assert.ok(insert);
        assert.equal((insert.params as unknown[])[4], "epub");
        assert.equal(body.fileType, "application/epub+zip");
        assert.equal(body.book.fileType, "epub");
        assert.equal(body.book.title, "Example.epub");
        const queued = scripted.effects.find(
            (effect) => effect.target === "queue.book-processing.add"
        );
        assert.deepEqual(queued?.payload, {
            bookId: body.book.id,
            userId: "owner-1",
            fileKey: body.book.fileKey,
            fileType: "epub",
        });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books falls back to the inserted row when the queued re-read is empty", async () => {
    let insertedRow: Record<string, unknown> | undefined;
    const scripted = createScriptedDb([
        authUser,
        {
            op: "insert",
            table: "books",
            rows: (params) => {
                insertedRow = {
                    id: params[0],
                    title: params[1],
                    user_id: params[2],
                    file_key: params[3],
                    file_type: params[4],
                    collection_name: null,
                    processing_status: params[5],
                    processing_error: params[6],
                    created_at: "2024-01-01 00:00:00",
                };
                return [insertedRow];
            },
        },
        { op: "select", table: "books", rows: [] },
    ]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await postBooksUpload(testApp.baseUrl, {
            cookie: AUTH_COOKIE,
            parts: [
                {
                    name: "file",
                    filename: "Example.pdf",
                    contentType: "application/pdf",
                    base64: PDF_BYTES.toString("base64"),
                },
            ],
        });
        assert.equal(res.status, 202);
        const body = await res.json();
        const insert = scripted.effects.find(
            (effect) => effect.operation === "insert"
        );
        assert.ok(insert);
        assert.equal(body.book.id, (insert.params as unknown[])[0]);
        assert.equal(body.book.fileKey, (insert.params as unknown[])[3]);
        assert.equal(body.book.processingStatus, "processing");
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books returns 500 Upload failed when storage rejects before insert", async () => {
    const scripted = createScriptedDb([authUser]);
    const ports = createPorts(scripted.effects, {
        uploadFile: async (key: string, file: Buffer) => {
            scripted.effects.push({
                type: "external",
                target: "storage.uploadFile",
                key,
                bytes: file.length,
                file,
            });
            throw new Error("storage down");
        },
    });
    const testApp = await createBooksTestApp(scripted, ports);
    try {
        const res = await postBooksUpload(testApp.baseUrl, {
            cookie: AUTH_COOKIE,
            parts: [
                {
                    name: "file",
                    filename: "Example.pdf",
                    contentType: "application/pdf",
                    base64: PDF_BYTES.toString("base64"),
                },
            ],
        });
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { error: "Upload failed" });
        assert.deepEqual(effectNames(scripted.effects), [
            "db.select users",
            "storage.uploadFile",
        ]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books returns 500 Upload failed when the insert fails after storage", async () => {
    const scripted = createScriptedDb([
        authUser,
        { op: "insert", table: "books", error: "insert failed" },
    ]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await postBooksUpload(testApp.baseUrl, {
            cookie: AUTH_COOKIE,
            parts: [
                {
                    name: "file",
                    filename: "Example.pdf",
                    contentType: "application/pdf",
                    base64: PDF_BYTES.toString("base64"),
                },
            ],
        });
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { error: "Upload failed" });
        assert.deepEqual(effectNames(scripted.effects), [
            "db.select users",
            "storage.uploadFile",
            "db.insert books",
        ]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books returns 503 and persists queue_failed via injected service dependencies", async () => {
    let insertedRow: Record<string, unknown> | undefined;
    const scripted = createScriptedDb([
        authUser,
        {
            op: "insert",
            table: "books",
            rows: (params) => {
                insertedRow = {
                    id: params[0],
                    title: params[1],
                    user_id: params[2],
                    file_key: params[3],
                    file_type: params[4],
                    collection_name: null,
                    processing_status: params[5],
                    processing_error: params[6],
                    created_at: "2024-01-01 00:00:00",
                };
                return [insertedRow];
            },
        },
        { op: "update", table: "books" },
    ]);
    const ports = createPorts(scripted.effects, {
        enqueueBookProcessing: (payload: unknown) =>
            handleBookProcessingEnqueue(payload as never, {
                enqueue: async () => {
                    scripted.effects.push({
                        type: "external",
                        target: "queue.book-processing.add",
                        payload,
                    });
                    throw new Error("queue down");
                },
                repository: createBookProcessingEnqueueRepository(
                    scripted.db as never
                ),
            }),
    });
    const testApp = await createBooksTestApp(scripted, ports);
    try {
        const res = await postBooksUpload(testApp.baseUrl, {
            cookie: AUTH_COOKIE,
            parts: [
                {
                    name: "file",
                    filename: "Example.pdf",
                    contentType: "application/pdf",
                    base64: PDF_BYTES.toString("base64"),
                },
            ],
        });
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), {
            error: "Book processing queue is unavailable",
        });
        const bookId = insertedRow!.id;
        const marking = scripted.effects.at(-1);
        assert.equal(marking?.operation, "update");
        assert.equal(marking?.table, "books");
        assert.deepEqual(marking?.params, [
            "queue_failed",
            "Book processing queue unavailable: queue down",
            bookId,
            "owner-1",
            "processing",
        ]);
        assert.deepEqual(effectNames(scripted.effects), [
            "db.select users",
            "storage.uploadFile",
            "db.insert books",
            "queue.book-processing.add",
            "db.update books",
        ]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books full-stack returns 413 for an over-80MiB file", async () => {
    const scripted = createScriptedDb([authUser]);
    const testApp = await createFullStackBooksApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const boundary = "----reader-test-boundary-80mb";
        const head = Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.pdf"\r\nContent-Type: application/pdf\r\n\r\n`
        );
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
        const fileBytes = 80 * 1024 * 1024 + 1;
        const fill = Buffer.alloc(4 * 1024 * 1024, 0x41);
        const fileChunks = function* () {
            let remaining = fileBytes;
            while (remaining > 0) {
                const slice = Math.min(remaining, fill.length);
                yield fill.subarray(0, slice);
                remaining -= slice;
            }
        };
        const res = await sendRaw(testApp.baseUrl, {
            path: "/api/books",
            headers: {
                cookie: AUTH_COOKIE,
                origin: TRUSTED_ORIGIN,
                "content-type": `multipart/form-data; boundary=${boundary}`,
                "content-length": String(head.length + fileBytes + tail.length),
            },
            chunks: [head, ...fileChunks(), tail],
        });
        assert.equal(res.status, 413);
        assert.deepEqual(JSON.parse(res.body.toString("utf8")), {
            error: "Payload too large",
        });
        assert.deepEqual(effectNames(scripted.effects), ["db.select users"]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books full-stack returns 400 for a truncated multipart body", async () => {
    const scripted = createScriptedDb([authUser]);
    const testApp = await createFullStackBooksApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await postBooksUpload(testApp.baseUrl, {
            cookie: AUTH_COOKIE,
            origin: TRUSTED_ORIGIN,
            truncateAt: 170,
            parts: [
                {
                    name: "file",
                    filename: "Example.pdf",
                    contentType: "application/pdf",
                    base64: PDF_BYTES.toString("base64"),
                },
            ],
        });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Malformed upload" });
        assert.deepEqual(effectNames(scripted.effects), ["db.select users"]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books full-stack returns 400 for an unexpected field", async () => {
    const scripted = createScriptedDb([authUser]);
    const testApp = await createFullStackBooksApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await postBooksUpload(testApp.baseUrl, {
            cookie: AUTH_COOKIE,
            origin: TRUSTED_ORIGIN,
            parts: [
                {
                    name: "notfile",
                    filename: "Example.pdf",
                    contentType: "application/pdf",
                    base64: PDF_BYTES.toString("base64"),
                },
            ],
        });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Malformed upload" });
        assert.deepEqual(effectNames(scripted.effects), ["db.select users"]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books full-stack returns 400 for an oversized field value", async () => {
    const scripted = createScriptedDb([authUser]);
    const testApp = await createFullStackBooksApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await postBooksUpload(testApp.baseUrl, {
            cookie: AUTH_COOKIE,
            origin: TRUSTED_ORIGIN,
            parts: [{ name: "title", text: "x".repeat(1024 * 1024 + 1) }],
        });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Malformed upload" });
        assert.deepEqual(effectNames(scripted.effects), ["db.select users"]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("GET /api/books lists the owner's books", async () => {
    const scripted = createScriptedDb([
        authUser,
        { op: "select", table: "books", rows: [BOOK_ROW] },
    ]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books`, {
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), {
            books: [
                {
                    id: "book-1",
                    title: "Example.pdf",
                    userId: "owner-1",
                    fileKey: "file-1",
                    fileType: "pdf",
                    collectionName: "collection-1",
                    processingStatus: "ready",
                    processingError: null,
                    createdAt: "2024-01-01T00:00:00.000Z",
                },
            ],
        });
        const list = scripted.effects.at(-1);
        assert.equal(list?.operation, "select");
        assert.equal(list?.table, "books");
        assert.deepEqual(list?.params, ["owner-1"]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books/:id/retry returns 404 for a missing book", async () => {
    const scripted = createScriptedDb([authUser, emptyBookSelect]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(
            `${testApp.baseUrl}/api/books/missing-book/retry`,
            { method: "POST", headers: { cookie: AUTH_COOKIE } }
        );
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: "Book was not found" });
        assert.deepEqual(effectNames(scripted.effects), [
            "db.select users",
            "db.select books",
        ]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books/:id/retry returns 404 for a non-owner book", async () => {
    const scripted = createScriptedDb([authUser, emptyBookSelect]);
    let lockCalled = false;
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects),
        {
            withLock: async () => {
                lockCalled = true;
                throw new BookLifecycleLockTimeoutError("book-1");
            },
        }
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1/retry`, {
            method: "POST",
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: "Book was not found" });
        assert.deepEqual(effectNames(scripted.effects), [
            "db.select users",
            "db.select books",
        ]);
        assert.equal(lockCalled, false);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books/:id/retry returns 409 for a non-retryable book", async () => {
    const scripted = createScriptedDb([
        authUser,
        bookById(BOOK_ROW),
        bookById(BOOK_ROW),
    ]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1/retry`, {
            method: "POST",
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 409);
        assert.deepEqual(await res.json(), { error: "Book is not retryable" });
        assert.deepEqual(effectNames(scripted.effects), [
            "db.select users",
            "db.select books",
            "db.select books",
        ]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books/:id/retry returns 409 when fileType is missing", async () => {
    const scripted = createScriptedDb([
        authUser,
        bookById({ ...FAILED_BOOK_ROW, file_type: null }),
        bookById({ ...FAILED_BOOK_ROW, file_type: null }),
    ]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1/retry`, {
            method: "POST",
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 409);
        assert.deepEqual(await res.json(), { error: "Book is not retryable" });
        assert.deepEqual(effectNames(scripted.effects), [
            "db.select users",
            "db.select books",
            "db.select books",
        ]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

for (const status of ["failed", "queue_failed"] as const) {
    test(`POST /api/books/:id/retry re-enqueues a ${status} book with the unchanged payload`, async () => {
        const row =
            status === "failed" ? FAILED_BOOK_ROW : QUEUE_FAILED_BOOK_ROW;
        const scripted = createScriptedDb([
            authUser,
            bookById(row),
            bookById(row),
            {
                op: "update",
                table: "books",
                rows: [
                    {
                        ...row,
                        processing_status: "processing",
                        processing_error: null,
                    },
                ],
            },
        ]);
        const testApp = await createBooksTestApp(
            scripted,
            createPorts(scripted.effects)
        );
        try {
            const res = await fetch(
                `${testApp.baseUrl}/api/books/book-1/retry`,
                { method: "POST", headers: { cookie: AUTH_COOKIE } }
            );
            assert.equal(res.status, 202);
            assert.deepEqual(await res.json(), {
                bookId: "book-1",
                status: "processing",
            });
            const effects = scripted.effects;
            const select = effects.find(
                (effect) =>
                    effect.operation === "select" && effect.table === "books"
            );
            const update = effects.find(
                (effect) => effect.operation === "update"
            );
            const queued = effects.find(
                (effect) => effect.target === "queue.book-processing.add"
            );
            assert.equal(select?.operation, "select");
            assert.deepEqual(select?.params, ["book-1", "owner-1"]);
            assert.deepEqual(update?.params, [
                "processing",
                null,
                "book-1",
                "owner-1",
                status,
            ]);
            assert.deepEqual(queued?.payload, {
                bookId: "book-1",
                userId: "owner-1",
                fileKey: "file-1",
                fileType: "pdf",
            });
            assert.deepEqual(effectNames(effects), [
                "db.select users",
                "db.select books",
                "db.select books",
                "db.update books",
                "queue.book-processing.add",
            ]);
        } finally {
            await testApp.close();
        }
        assertScriptedDbComplete(scripted);
    });
}

test("POST /api/books/:id/retry returns 503 when the queue is unavailable and marks queue_failed", async () => {
    const scripted = createScriptedDb([
        authUser,
        bookById(FAILED_BOOK_ROW),
        bookById(FAILED_BOOK_ROW),
        {
            op: "update",
            table: "books",
            rows: [
                {
                    ...FAILED_BOOK_ROW,
                    processing_status: "processing",
                    processing_error: null,
                },
            ],
        },
        { op: "update", table: "books" },
    ]);
    const ports = createPorts(scripted.effects, {
        enqueueBookProcessing: async (payload: unknown) => {
            scripted.effects.push({
                type: "external",
                target: "queue.book-processing.add",
                payload,
            });
            throw new Error("queue down");
        },
    });
    const testApp = await createBooksTestApp(scripted, ports);
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1/retry`, {
            method: "POST",
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), {
            error: "Book processing queue is unavailable",
        });
        const updates = scripted.effects.filter(
            (effect) => effect.operation === "update"
        );
        assert.equal(updates.length, 2);
        assert.deepEqual(updates[0].params, [
            "processing",
            null,
            "book-1",
            "owner-1",
            "failed",
        ]);
        assert.deepEqual(updates[1].params, [
            "queue_failed",
            "Book processing queue unavailable: queue down",
            "book-1",
            "owner-1",
            "processing",
        ]);
        assert.deepEqual(effectNames(scripted.effects), [
            "db.select users",
            "db.select books",
            "db.select books",
            "db.update books",
            "queue.book-processing.add",
            "db.update books",
        ]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST /api/books/:id/retry returns 500 when the book select fails", async () => {
    const scripted = createScriptedDb([
        authUser,
        { op: "select", table: "books", error: "connection reset" },
    ]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1/retry`, {
            method: "POST",
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), {
            error: "Internal server error",
        });
        assert.deepEqual(effectNames(scripted.effects), [
            "db.select users",
            "db.select books",
        ]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("GET /api/books/:id/status reports a ready book with a collection", async () => {
    const scripted = createScriptedDb([authUser, bookById(BOOK_ROW)]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1/status`, {
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), {
            bookId: "book-1",
            fileType: "pdf",
            ready: true,
            status: "ready",
            error: null,
        });
        const select = scripted.effects.at(-1);
        assert.equal(select?.operation, "select");
        assert.deepEqual(select?.params, ["book-1"]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("GET /api/books/:id/status reports ready false without a collection", async () => {
    const scripted = createScriptedDb([
        authUser,
        bookById(READY_NO_COLLECTION_BOOK_ROW),
    ]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1/status`, {
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), {
            bookId: "book-1",
            fileType: "pdf",
            ready: false,
            status: "ready",
            error: null,
        });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

for (const [status, processingError] of [
    ["processing", null],
    ["failed", "boom"],
    ["queue_failed", "queue down"],
    ["deleting", null],
] as const) {
    test(`GET /api/books/:id/status preserves ${status} state`, async () => {
        const scripted = createScriptedDb([
            authUser,
            bookById({
                ...BOOK_ROW,
                processing_status: status,
                processing_error: processingError,
            }),
        ]);
        const testApp = await createBooksTestApp(
            scripted,
            createPorts(scripted.effects)
        );
        try {
            const res = await fetch(
                `${testApp.baseUrl}/api/books/book-1/status`,
                { headers: { cookie: AUTH_COOKIE } }
            );
            assert.equal(res.status, 200);
            assert.deepEqual(await res.json(), {
                bookId: "book-1",
                fileType: "pdf",
                ready: false,
                status,
                error: processingError,
            });
        } finally {
            await testApp.close();
        }
        assertScriptedDbComplete(scripted);
    });
}

test("GET /api/books/:id/status returns 404 for a missing book", async () => {
    const scripted = createScriptedDb([authUser, emptyBookSelect]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(
            `${testApp.baseUrl}/api/books/missing-book/status`,
            { headers: { cookie: AUTH_COOKIE } }
        );
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: "Book was not found" });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("GET /api/books/:id/status returns 403 for a non-owner", async () => {
    const scripted = createScriptedDb([
        authUser,
        bookById(OTHER_OWNER_BOOK_ROW),
    ]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1/status`, {
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 403);
        assert.deepEqual(await res.json(), { error: "Not authorized" });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("GET /api/books/:id/status returns 500 when the book select fails", async () => {
    const scripted = createScriptedDb([
        authUser,
        { op: "select", table: "books", error: "connection reset" },
    ]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1/status`, {
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), {
            error: "Internal server error",
        });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("DELETE /api/books/:id runs the ordered cleanup and returns 204", async () => {
    const scripted = createScriptedDb(deleteSuccessfulSteps(BOOK_ROW));
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1`, {
            method: "DELETE",
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 204);
        assert.equal(await res.text(), "");
        const effects = scripted.effects;
        assert.deepEqual(effectNames(effects), [
            "db.select users",
            "db.select books",
            "db.update books",
            "db.select books",
            "db.select books",
            "storage.deleteFile",
            "db.select books",
            "vectorStore.deleteCollection",
            "bookSearchChunks.deleteCollection",
            "hybridBookSearch.clearCollectionCache",
            "db.delete books",
            "db.delete conversations",
        ]);
        const marking = effects.find((effect) => effect.operation === "update");
        assert.deepEqual(marking?.params, [
            "deleting",
            "book-1",
            "owner-1",
            "processing",
            "ready",
            "failed",
            "queue_failed",
            "deleting",
        ]);
        const count = effects[4];
        assert.deepEqual(count.params, ["file-1", "book-1", "deleting"]);
        const fileDelete = effects.find(
            (effect) => effect.target === "storage.deleteFile"
        );
        assert.equal(fileDelete?.key, "file-1");
        const vector = effects.find(
            (effect) => effect.target === "vectorStore.deleteCollection"
        );
        const chunks = effects.find(
            (effect) => effect.target === "bookSearchChunks.deleteCollection"
        );
        const cache = effects.find(
            (effect) =>
                effect.target === "hybridBookSearch.clearCollectionCache"
        );
        assert.equal(vector?.collectionName, "collection-1");
        assert.equal(chunks?.collectionName, "collection-1");
        assert.equal(cache?.collectionName, "collection-1");
        const rowDelete = effects.find(
            (effect) =>
                effect.operation === "delete" && effect.table === "books"
        );
        assert.deepEqual(rowDelete?.params, ["book-1", "owner-1", "deleting"]);
        assert.ok(
            !effects.some((effect) =>
                String(effect.target ?? "").startsWith("queue.")
            )
        );
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("DELETE /api/books/:id keeps a shared file in storage but still cleans per-book resources", async () => {
    const scripted = createScriptedDb(deleteSuccessfulSteps(BOOK_ROW, 1));
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1`, {
            method: "DELETE",
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 204);
        const effects = scripted.effects;
        assert.deepEqual(effectNames(effects), [
            "db.select users",
            "db.select books",
            "db.update books",
            "db.select books",
            "db.select books",
            "db.select books",
            "vectorStore.deleteCollection",
            "bookSearchChunks.deleteCollection",
            "hybridBookSearch.clearCollectionCache",
            "db.delete books",
            "db.delete conversations",
        ]);
        assert.ok(
            !effects.some((effect) => effect.target === "storage.deleteFile")
        );
        const vector = effects.find(
            (effect) => effect.target === "vectorStore.deleteCollection"
        );
        assert.equal(vector?.collectionName, "collection-1");
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("DELETE /api/books/:id derives the collection name when missing", async () => {
    const scripted = createScriptedDb(
        deleteSuccessfulSteps(NULL_COLLECTION_BOOK_ROW)
    );
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1`, {
            method: "DELETE",
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 204);
        const vector = scripted.effects.find(
            (effect) => effect.target === "vectorStore.deleteCollection"
        );
        const chunks = scripted.effects.find(
            (effect) => effect.target === "bookSearchChunks.deleteCollection"
        );
        const cache = scripted.effects.find(
            (effect) =>
                effect.target === "hybridBookSearch.clearCollectionCache"
        );
        assert.equal(vector?.collectionName, "book_book_1");
        assert.equal(chunks?.collectionName, "book_book_1");
        assert.equal(cache?.collectionName, "book_book_1");
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("DELETE /api/books/:id returns 404 for a missing book before side effects", async () => {
    const scripted = createScriptedDb([authUser, emptyBookSelect]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/missing-book`, {
            method: "DELETE",
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: "Book was not found" });
        assert.deepEqual(effectNames(scripted.effects), [
            "db.select users",
            "db.select books",
        ]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("DELETE /api/books/:id returns 403 for a non-owner before side effects", async () => {
    const scripted = createScriptedDb([
        authUser,
        bookById(OTHER_OWNER_BOOK_ROW),
    ]);
    const testApp = await createBooksTestApp(
        scripted,
        createPorts(scripted.effects)
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1`, {
            method: "DELETE",
            headers: { cookie: AUTH_COOKIE },
        });
        assert.equal(res.status, 403);
        assert.deepEqual(await res.json(), { error: "Not authorized" });
        assert.deepEqual(effectNames(scripted.effects), [
            "db.select users",
            "db.select books",
        ]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

type DeleteStage =
    | "select"
    | "update"
    | "count"
    | "storage"
    | "vector"
    | "chunks"
    | "cache"
    | "delete";

const deleteStagePrefixes: Record<DeleteStage, string[]> = {
    select: ["db.select users", "db.select books"],
    update: ["db.select users", "db.select books", "db.update books"],
    count: [
        "db.select users",
        "db.select books",
        "db.update books",
        "db.select books",
        "db.select books",
    ],
    storage: [
        "db.select users",
        "db.select books",
        "db.update books",
        "db.select books",
        "db.select books",
        "storage.deleteFile",
    ],
    vector: [
        "db.select users",
        "db.select books",
        "db.update books",
        "db.select books",
        "db.select books",
        "storage.deleteFile",
        "db.select books",
        "vectorStore.deleteCollection",
    ],
    chunks: [
        "db.select users",
        "db.select books",
        "db.update books",
        "db.select books",
        "db.select books",
        "storage.deleteFile",
        "db.select books",
        "vectorStore.deleteCollection",
        "bookSearchChunks.deleteCollection",
    ],
    cache: [
        "db.select users",
        "db.select books",
        "db.update books",
        "db.select books",
        "db.select books",
        "storage.deleteFile",
        "db.select books",
        "vectorStore.deleteCollection",
        "bookSearchChunks.deleteCollection",
        "hybridBookSearch.clearCollectionCache",
    ],
    delete: [
        "db.select users",
        "db.select books",
        "db.update books",
        "db.select books",
        "db.select books",
        "storage.deleteFile",
        "db.select books",
        "vectorStore.deleteCollection",
        "bookSearchChunks.deleteCollection",
        "hybridBookSearch.clearCollectionCache",
        "db.delete books",
    ],
};

const deleteStageDbSteps = (failAt: DeleteStage): ScriptedStep[] => {
    const steps: ScriptedStep[] = [
        authUser,
        failAt === "select"
            ? { op: "select", table: "books", error: "connection reset" }
            : bookById(BOOK_ROW),
    ];
    if (failAt === "select") return steps;
    steps.push(
        failAt === "update"
            ? { op: "update", table: "books", error: "connection reset" }
            : { op: "update", table: "books", rows: [{ id: "book-1" }] }
    );
    if (failAt === "update") return steps;
    steps.push(
        bookById(BOOK_ROW),
        failAt === "count"
            ? { op: "select", table: "books", error: "connection reset" }
            : { op: "select", table: "books", rows: [{ count: 0 }] }
    );
    if (failAt === "count") return steps;
    if (failAt === "storage") return steps;
    steps.push({ op: "select", table: "books", rows: [{ count: 0 }] });
    if (failAt === "delete") {
        steps.push({
            op: "delete",
            table: "books",
            error: "connection reset",
        });
    }
    return steps;
};

const deleteStagePorts = (
    effects: RecordedEffect[],
    failAt: DeleteStage
): BooksPorts => {
    const overrides: Record<string, unknown> = {};
    if (failAt === "storage") {
        overrides.deleteFile = async (key: string) => {
            effects.push({
                type: "external",
                target: "storage.deleteFile",
                key,
            });
            throw new Error("storage down");
        };
    }
    if (failAt === "vector") {
        overrides.deleteVectorCollection = async (collectionName: string) => {
            effects.push({
                type: "external",
                target: "vectorStore.deleteCollection",
                collectionName,
            });
            throw new Error("vector down");
        };
    }
    if (failAt === "chunks") {
        overrides.deleteCollectionChunks = async (collectionName: string) => {
            effects.push({
                type: "external",
                target: "bookSearchChunks.deleteCollection",
                collectionName,
            });
            throw new Error("chunks down");
        };
    }
    if (failAt === "cache") {
        overrides.clearCollectionCache = (collectionName: string) => {
            effects.push({
                type: "external",
                target: "hybridBookSearch.clearCollectionCache",
                collectionName,
            });
            throw new Error("cache down");
        };
    }
    return createPorts(effects, overrides);
};

for (const failAt of [
    "select",
    "update",
    "count",
    "storage",
    "vector",
    "chunks",
    "cache",
    "delete",
] as const) {
    test(`DELETE /api/books/:id failure at ${failAt} returns 500 without later side effects`, async () => {
        const scripted = createScriptedDb(deleteStageDbSteps(failAt));
        const testApp = await createBooksTestApp(
            scripted,
            deleteStagePorts(scripted.effects, failAt)
        );
        try {
            const res = await fetch(`${testApp.baseUrl}/api/books/book-1`, {
                method: "DELETE",
                headers: { cookie: AUTH_COOKIE },
            });
            assert.equal(res.status, 500);
            assert.deepEqual(await res.json(), {
                error: "Failed to delete the file",
            });
            assert.deepEqual(
                effectNames(scripted.effects),
                deleteStagePrefixes[failAt]
            );
            assert.ok(
                !scripted.effects.some((effect) =>
                    String(effect.target ?? "").startsWith("queue.")
                )
            );
        } finally {
            await testApp.close();
        }
        assert.equal(scripted.remaining(), 0);
    });
}

test("enqueue failure marks queue_failed via injected repository", async () => {
    const updates: { table: unknown; values: unknown }[] = [];
    const fakeDb = {
        update(table: unknown) {
            return {
                set(values: unknown) {
                    updates.push({ table, values });
                    return { where: async () => [] };
                },
            };
        },
    };
    await assert.rejects(
        handleBookProcessingEnqueue(
            {
                bookId: "book-1",
                userId: "owner-1",
                fileKey: "key-1",
                fileType: "epub",
            },
            {
                enqueue: async () => {
                    throw new Error("queue down");
                },
                repository: createBookProcessingEnqueueRepository(
                    fakeDb as never
                ),
            }
        )
    );
    assert.equal(updates.length, 1);
    assert.equal(updates[0].table, Books);
    assert.deepEqual(updates[0].values, {
        processingStatus: "queue_failed",
        processingError: "Book processing queue unavailable: queue down",
    });
});
