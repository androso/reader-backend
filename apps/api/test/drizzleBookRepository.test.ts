import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgres://test:test@127.0.0.1:1/test";

const { drizzle } =
    require("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
const { createDrizzleBookRepository } =
    require("../src/infrastructure/books/drizzleBookRepository") as typeof import("../src/infrastructure/books/drizzleBookRepository");
const helper =
    require("./helpers/httpParity") as typeof import("./helpers/httpParity");

type QueryRecord = {
    operation: string;
    table?: string;
    sql: string;
    params: unknown[];
};

const BOOK_ROW: Record<string, unknown> = {
    id: "book-1",
    title: "Example.pdf",
    user_id: "owner-1",
    file_key: "file-1",
    file_type: "pdf",
    collection_name: null,
    processing_status: "processing",
    processing_error: null,
    created_at: "2024-01-01 00:00:00",
};

const createScriptedDb = (
    steps: Array<{
        operation: string;
        table: string;
        rows?: Record<string, unknown>[];
    }>
) => {
    const queries: QueryRecord[] = [];
    const client = {
        async query(queryConfig: unknown, params?: unknown[]) {
            const sql =
                typeof queryConfig === "string"
                    ? queryConfig
                    : ((queryConfig as { text?: string } | null | undefined)
                          ?.text ?? "");
            const { op: operation, table } = helper.classifyDbQuery(sql);
            const record = {
                operation,
                table,
                sql,
                params: helper.serializeParams(params),
            };
            queries.push(record);
            const step = steps.shift();
            assert.ok(step, `Unexpected query: ${sql}`);
            assert.equal(operation, step.operation);
            assert.equal(table, step.table);
            const columns = helper.extractResultColumns(sql);
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
        queries,
        remaining: () => steps.length,
    };
};

test("Drizzle book repository preserves statements, operation order, and parameters", async () => {
    const scripted = createScriptedDb([
        { operation: "insert", table: "books", rows: [BOOK_ROW] },
        { operation: "select", table: "books", rows: [BOOK_ROW] },
        {
            operation: "update",
            table: "books",
            rows: [{ id: "book-1" }],
        },
        { operation: "update", table: "books" },
        { operation: "update", table: "books" },
        { operation: "update", table: "books" },
    ]);
    const repository = createDrizzleBookRepository(scripted.db as never);

    const created = await repository.create({
        id: "book-1",
        title: "Example.pdf",
        userId: "owner-1",
        fileKey: "file-1",
        fileType: "pdf",
        processingStatus: "processing",
        processingError: null,
    });
    assert.equal(created.id, "book-1");

    const found = await repository.findById("book-1");
    assert.equal(found?.id, "book-1");
    assert.equal(
        scripted.queries[1].sql,
        'select "id", "title", "user_id", "file_key", "file_type", "collection_name", "processing_status", "processing_error", "created_at" from "books" where "books"."id" = $1'
    );

    assert.equal(
        await repository.markReady("book-1", "owner-1", "collection-1"),
        true
    );
    assert.equal(
        await repository.markReady("book-1", "owner-1", "collection-2"),
        false
    );
    await repository.markFailed("book-1", "owner-1", "processing error");
    await repository.markQueueFailed("book-1", "owner-1", "queue offline");

    assert.deepEqual(
        scripted.queries.map(({ operation, table }) => [operation, table]),
        [
            ["insert", "books"],
            ["select", "books"],
            ["update", "books"],
            ["update", "books"],
            ["update", "books"],
            ["update", "books"],
        ]
    );
    assert.deepEqual(scripted.queries[0].params, [
        "book-1",
        "Example.pdf",
        "owner-1",
        "file-1",
        "pdf",
        "processing",
        null,
    ]);
    assert.deepEqual(scripted.queries[1].params, ["book-1"]);
    assert.deepEqual(scripted.queries[2].params, [
        "collection-1",
        "ready",
        null,
        "book-1",
        "owner-1",
        "processing",
    ]);
    assert.deepEqual(scripted.queries[3].params, [
        "collection-2",
        "ready",
        null,
        "book-1",
        "owner-1",
        "processing",
    ]);
    assert.deepEqual(scripted.queries[4].params, [
        "failed",
        "processing error",
        "book-1",
        "owner-1",
        "processing",
    ]);
    assert.deepEqual(scripted.queries[5].params, [
        "queue_failed",
        "Book processing queue unavailable: queue offline",
        "book-1",
        "owner-1",
        "processing",
    ]);
    for (const query of scripted.queries.slice(2)) {
        assert.match(query.sql, /"books"\."user_id"/);
        assert.match(query.sql, /"books"\."processing_status"/);
    }
    assert.equal(scripted.remaining(), 0);
});
