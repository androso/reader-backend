import assert from "node:assert/strict";
import test from "node:test";
import type { User } from "../src/types";
import type { RecordedEffect } from "./helpers/httpParity";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";
process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:1/test";
process.env.REDIS_URL = "";
process.env.LANGFUSE_SAMPLE_RATE = "0";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { drizzle } =
    require("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
const { TrackerController } =
    require("../src/tracker/tracker.controller") as typeof import("../src/tracker/tracker.controller");
const { DRIZZLE } =
    require("../src/database/database.module") as typeof import("../src/database/database.module");
const { createTestApp } =
    require("./helpers/nestApp") as typeof import("./helpers/nestApp");
const helper =
    require("./helpers/httpParity") as typeof import("./helpers/httpParity");

const owner: User = {
    id: "owner-1",
    email: "owner@example.com",
    name: "Owner",
    image: null,
    googleId: null,
    username: "owner",
    password: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
};

const BOOK_SELECT_SQL =
    'select "id", "title", "user_id", "file_key", "file_type", "collection_name", "processing_status", "processing_error", "created_at" from "books" where ("books"."id" = $1 and "books"."user_id" = $2)';
const PROGRESS_SELECT_SQL =
    'select "user_id", "book_id", "progress_position", "progress_chapter", "last_read_at", "created_at", "updated_at" from "progress" where ("progress"."user_id" = $1 and "progress"."book_id" = $2)';
const PROGRESS_INSERT_SQL =
    'insert into "progress" ("user_id", "book_id", "progress_position", "progress_chapter", "last_read_at", "created_at", "updated_at") values ($1, $2, $3, $4, default, $5, $6) on conflict ("user_id","book_id") do update set "progress_position" = $7, "progress_chapter" = $8, "updated_at" = $9 returning "user_id", "book_id", "progress_position", "progress_chapter", "last_read_at", "created_at", "updated_at"';
const PROGRESS_INSERT_NO_CHAPTER_SQL =
    'insert into "progress" ("user_id", "book_id", "progress_position", "progress_chapter", "last_read_at", "created_at", "updated_at") values ($1, $2, $3, default, default, $4, $5) on conflict ("user_id","book_id") do update set "progress_position" = $6, "updated_at" = $7 returning "user_id", "book_id", "progress_position", "progress_chapter", "last_read_at", "created_at", "updated_at"';

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

const progressSelect = (rows: Record<string, unknown>[]): ScriptedStep => ({
    op: "select",
    table: "progress",
    rows,
});

const progressInsert = (rows: Record<string, unknown>[]): ScriptedStep => ({
    op: "insert",
    table: "progress",
    rows,
});

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

const createTrackerTestApp = (scripted: { db: unknown }, user?: User) =>
    createTestApp({
        controllers: [TrackerController],
        providers: [{ provide: DRIZZLE, useValue: scripted.db }],
        ...(user === undefined ? {} : { user }),
    });

const postProgress = (
    baseUrl: string,
    rid: string,
    options: { headers?: Record<string, string>; body?: string } = {}
) =>
    fetch(`${baseUrl}/api/${rid}/progress`, {
        method: "POST",
        headers: options.headers ?? {},
        body: options.body,
    });

test("rejects unauthenticated progress access", async () => {
    const scripted = createScriptedDb([]);
    const testApp = await createTrackerTestApp(scripted);
    try {
        const res = await fetch(`${testApp.baseUrl}/api/book-1/progress`);
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { message: "No token provided" });
        assert.deepEqual(scripted.effects, []);
    } finally {
        await testApp.close();
    }
});

test("returns 404 for a non-owner book id without reading progress", async () => {
    const scripted = createScriptedDb([emptyBookSelect]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await fetch(
            `${testApp.baseUrl}/api/someone-elses-book/progress`
        );
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { message: "Book not found" });
        const select = scripted.effects.at(-1);
        assert.equal(select?.sql, BOOK_SELECT_SQL);
        assert.deepEqual(select?.params, ["someone-elses-book", "owner-1"]);
        assert.equal(scripted.effects.length, 1);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("returns 404 for a missing owned book id", async () => {
    const scripted = createScriptedDb([emptyBookSelect]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await fetch(`${testApp.baseUrl}/api/missing-book/progress`);
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { message: "Book not found" });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("returns the initial position when no progress row exists", async () => {
    const scripted = createScriptedDb([
        bookById(helper.BOOK_ROW),
        progressSelect([]),
    ]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await fetch(`${testApp.baseUrl}/api/book-1/progress`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { progressPosition: null });
        const select = scripted.effects.at(-1);
        assert.equal(select?.sql, PROGRESS_SELECT_SQL);
        assert.deepEqual(select?.params, ["owner-1", "book-1"]);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("returns owner progress for an owned book id", async () => {
    const scripted = createScriptedDb([
        bookById(helper.BOOK_ROW),
        progressSelect([helper.PROGRESS_ROW]),
    ]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await fetch(`${testApp.baseUrl}/api/book-1/progress`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), {
            progressPosition: "p1",
            progressChapter: "c1",
        });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("returns 500 when the book select fails", async () => {
    const scripted = createScriptedDb([
        { op: "select", table: "books", error: "connection reset" },
    ]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await fetch(`${testApp.baseUrl}/api/book-1/progress`);
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), {
            message: "Internal server error",
        });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("writes owner progress for an owned book id", async () => {
    const scripted = createScriptedDb([
        bookById(helper.BOOK_ROW),
        progressInsert([helper.PROGRESS_ROW]),
    ]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await postProgress(testApp.baseUrl, "book-1", {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                progress_block: "p1",
                progress_chapter: "c1",
            }),
        });
        assert.equal(res.status, 201);
        const body = await res.json();
        assert.deepEqual(body, {
            message: "Progress saved",
            data: {
                userId: "owner-1",
                bookId: "book-1",
                progressPosition: "p1",
                progressChapter: "c1",
                lastReadAt: "2024-01-01T00:00:00.000Z",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
            },
        });
        const insert = scripted.effects.at(-1);
        assert.equal(insert?.sql, PROGRESS_INSERT_SQL);
        const params = insert?.params as unknown[];
        assert.deepEqual(
            [params[0], params[1], params[2], params[3]],
            ["owner-1", "book-1", "p1", "c1"]
        );
        assert.deepEqual([params[6], params[7]], ["p1", "c1"]);
        for (const index of [4, 5, 8]) {
            assert.match(params[index] as string, /T.*Z$/);
        }
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("writes owner progress from a urlencoded body", async () => {
    const scripted = createScriptedDb([
        bookById(helper.BOOK_ROW),
        progressInsert([helper.PROGRESS_ROW]),
    ]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await postProgress(testApp.baseUrl, "book-1", {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: "progress_block=p1&progress_chapter=c1",
        });
        assert.equal(res.status, 201);
        const body = await res.json();
        assert.equal(body.message, "Progress saved");
        assert.equal(body.data.progressPosition, "p1");
        assert.equal(body.data.progressChapter, "c1");
        const insert = scripted.effects.at(-1);
        assert.equal(insert?.sql, PROGRESS_INSERT_SQL);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("writes progress without a chapter using column defaults", async () => {
    const scripted = createScriptedDb([
        bookById(helper.BOOK_ROW),
        progressInsert([helper.PROGRESS_ROW_NO_CHAPTER]),
    ]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await postProgress(testApp.baseUrl, "book-1", {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ progress_block: "p1" }),
        });
        assert.equal(res.status, 201);
        const body = await res.json();
        assert.equal(body.message, "Progress saved");
        assert.equal(body.data.progressPosition, "p1");
        assert.equal(body.data.progressChapter, null);
        const insert = scripted.effects.at(-1);
        assert.equal(insert?.sql, PROGRESS_INSERT_NO_CHAPTER_SQL);
        assert.deepEqual(
            (insert?.params as unknown[] | undefined)?.slice(0, 3),
            ["owner-1", "book-1", "p1"]
        );
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("accepts a truthy non-string progress block unchanged", async () => {
    const scripted = createScriptedDb([
        bookById(helper.BOOK_ROW),
        progressInsert([helper.PROGRESS_ROW]),
    ]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await postProgress(testApp.baseUrl, "book-1", {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ progress_block: 123 }),
        });
        assert.equal(res.status, 201);
        const insert = scripted.effects.at(-1);
        assert.equal((insert?.params as unknown[])[2], 123);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("returns 404 when posting progress for a missing book", async () => {
    const scripted = createScriptedDb([emptyBookSelect]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await postProgress(testApp.baseUrl, "book-1", {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ progress_block: "p1" }),
        });
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { message: "Book not found" });
        assert.equal(scripted.effects.length, 1);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("returns 500 when the progress insert fails", async () => {
    const scripted = createScriptedDb([
        bookById(helper.BOOK_ROW),
        { op: "insert", table: "progress", error: "connection reset" },
    ]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await postProgress(testApp.baseUrl, "book-1", {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: "progress_block=p1&progress_chapter=c1",
        });
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), {
            message: "Progress wasn't saved",
        });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST progress without a body returns 400", async () => {
    const scripted = createScriptedDb([]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await postProgress(testApp.baseUrl, "book-1");
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), {
            message: "Progress Block is required",
        });
        assert.deepEqual(scripted.effects, []);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST progress with an empty json body returns 400", async () => {
    const scripted = createScriptedDb([]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await postProgress(testApp.baseUrl, "book-1", {
            headers: { "Content-Type": "application/json" },
            body: "",
        });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), {
            message: "Progress Block is required",
        });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST progress with a text/plain body returns 400", async () => {
    const scripted = createScriptedDb([]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await postProgress(testApp.baseUrl, "book-1", {
            headers: { "Content-Type": "text/plain" },
            body: "{}",
        });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), {
            message: "Progress Block is required",
        });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST progress with an empty urlencoded body returns 400", async () => {
    const scripted = createScriptedDb([]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await postProgress(testApp.baseUrl, "book-1", {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: "",
        });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), {
            message: "Progress Block is required",
        });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST progress with an empty progress_block returns 400", async () => {
    const scripted = createScriptedDb([]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await postProgress(testApp.baseUrl, "book-1", {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ progress_block: "" }),
        });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), {
            message: "Progress Block is required",
        });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("POST progress with an empty object body returns 400", async () => {
    const scripted = createScriptedDb([]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await postProgress(testApp.baseUrl, "book-1", {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), {
            message: "Progress Block is required",
        });
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});

test("GET /api/progress is not exposed", async () => {
    const scripted = createScriptedDb([]);
    const testApp = await createTrackerTestApp(scripted, owner);
    try {
        const res = await fetch(`${testApp.baseUrl}/api/progress`);
        assert.equal(res.status, 404);
    } finally {
        await testApp.close();
    }
    assertScriptedDbComplete(scripted);
});
