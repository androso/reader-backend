import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgres://test:test@127.0.0.1:1/test";

const { drizzle } =
    require("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
const { createDrizzleChatConversationRepository } =
    require("../src/infrastructure/chat/drizzleChatConversationRepository") as typeof import("../src/infrastructure/chat/drizzleChatConversationRepository");
const { createDrizzleChatMessageRepository } =
    require("../src/infrastructure/chat/drizzleChatMessageRepository") as typeof import("../src/infrastructure/chat/drizzleChatMessageRepository");
const { createChatResourceAccess } =
    require("../src/infrastructure/chat/chatResourceAccess") as typeof import("../src/infrastructure/chat/chatResourceAccess");
const {
    ChatResourceAccessDeniedError,
    ChatResourceNotFoundError,
    ChatValidationError,
} = require("@reader/domain") as typeof import("@reader/domain");
const helper =
    require("./helpers/httpParity") as typeof import("./helpers/httpParity");

type QueryStep = {
    operation: string;
    table: string;
    rows?: Record<string, unknown>[];
};

const createScriptedDb = (steps: QueryStep[]) => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
        async query(queryConfig: unknown, params?: unknown[]) {
            const sql =
                typeof queryConfig === "string"
                    ? queryConfig
                    : ((queryConfig as { text?: string } | null | undefined)
                          ?.text ?? "");
            const operation = helper.classifyDbQuery(sql);
            queries.push({
                sql,
                params: helper.serializeParams(params),
            });
            const step = steps.shift();
            assert.ok(step, `Unexpected query: ${sql}`);
            assert.equal(operation.op, step.operation);
            assert.equal(operation.table, step.table);
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

const conversationRow: Record<string, unknown> = {
    id: "conversation-1",
    user_id: "user-1",
    title: "A title",
    created_at: new Date("2024-01-01T00:00:00.000Z"),
    last_message_at: new Date("2024-01-02T00:00:00.000Z"),
    resource_type: "book",
    resource_id: "book-1",
};

const messageRow: Record<string, unknown> = {
    id: "message-1",
    conversation_id: "conversation-1",
    role: "assistant",
    content: "Answer",
    context_sources: null,
    completion_status: "complete",
    finish_reason: "stop",
    created_at: new Date("2024-01-01T00:00:00.000Z"),
    execution_metadata: { private: true },
};

test("Drizzle chat repositories preserve scope, order, and public message selection", async () => {
    const scripted = createScriptedDb([
        {
            operation: "select",
            table: "conversations",
            rows: [conversationRow],
        },
        {
            operation: "select",
            table: "conversations",
            rows: [conversationRow],
        },
        {
            operation: "select",
            table: "messages",
            rows: [messageRow],
        },
    ]);
    const conversations = createDrizzleChatConversationRepository(
        scripted.db as never
    );
    const messages = createDrizzleChatMessageRepository(scripted.db as never);

    const listed = await conversations.listScoped({
        userId: "user-1",
        resourceType: "book",
        resourceId: "book-1",
    });
    assert.equal(listed[0]?.id, "conversation-1");
    assert.deepEqual(scripted.queries[0].params, ["user-1", "book", "book-1"]);
    assert.match(scripted.queries[0].sql, /"conversations"\."user_id"/);
    assert.match(scripted.queries[0].sql, /"conversations"\."resource_type"/);
    assert.match(scripted.queries[0].sql, /"conversations"\."resource_id"/);
    assert.match(
        scripted.queries[0].sql,
        /order by "conversations"\."last_message_at" desc$/
    );

    const found = await conversations.findScoped({
        conversationId: "conversation-1",
        userId: "user-1",
        resourceType: "book",
        resourceId: "book-1",
    });
    assert.equal(found?.id, "conversation-1");
    assert.deepEqual(scripted.queries[1].params, [
        "conversation-1",
        "user-1",
        "book",
        "book-1",
    ]);
    for (const column of ["id", "user_id", "resource_type", "resource_id"]) {
        assert.ok(
            scripted.queries[1].sql.includes(`"conversations"."${column}"`)
        );
    }

    const result = await messages.listForConversation("conversation-1");
    assert.equal(result[0]?.id, "message-1");
    assert.ok(!("executionMetadata" in result[0]));
    assert.deepEqual(scripted.queries[2].params, ["conversation-1"]);
    assert.ok(
        !scripted.queries[2].sql.includes("execution_metadata"),
        "public message projection must not select private execution metadata"
    );
    assert.match(
        scripted.queries[2].sql,
        /order by "messages"\."created_at"( asc)?$/
    );
    assert.equal(scripted.remaining(), 0);
});

test("Drizzle chat write and history methods preserve the moved query shapes", async () => {
    const scripted = createScriptedDb([
        {
            operation: "insert",
            table: "conversations",
            rows: [{ id: "conversation-2" }],
        },
        { operation: "update", table: "conversations" },
        {
            operation: "insert",
            table: "messages",
            rows: [{ id: "message-2" }],
        },
        {
            operation: "select",
            table: "messages",
            rows: [{ role: "user", content: "Question" }],
        },
    ]);
    const conversations = createDrizzleChatConversationRepository(
        scripted.db as never
    );
    const messages = createDrizzleChatMessageRepository(scripted.db as never);

    const created = await conversations.create({
        userId: "user-1",
        title: "Question...",
        resourceType: "book",
        resourceId: "book-1",
    });
    assert.equal(created.id, "conversation-2");
    assert.deepEqual(scripted.queries[0].params, [
        "user-1",
        "Question...",
        "book",
        "book-1",
    ]);
    assert.match(scripted.queries[0].sql, /insert into "conversations"/);

    await conversations.touch("conversation-2", new Date(0));
    assert.deepEqual(scripted.queries[1].params, [
        new Date(0).toISOString(),
        "conversation-2",
    ]);
    assert.match(scripted.queries[1].sql, /update "conversations"/);

    const saved = await messages.append({
        conversationId: "conversation-2",
        role: "user",
        content: "Question",
    });
    assert.equal(saved.id, "message-2");
    assert.deepEqual(scripted.queries[2].params.slice(0, 2), [
        "conversation-2",
        "user",
    ]);
    assert.match(scripted.queries[2].sql, /insert into "messages"/);
    assert.match(
        scripted.queries[2].sql,
        /values \(default, \$1, \$2, \$3, default/
    );

    const history =
        await messages.listHistoryForConversation!("conversation-2");
    assert.deepEqual(history, [{ role: "user", content: "Question" }]);
    assert.deepEqual(scripted.queries[3].params, ["conversation-2"]);
    assert.ok(!scripted.queries[3].sql.includes("execution_metadata"));
    assert.match(
        scripted.queries[3].sql,
        /order by "messages"\."created_at"( asc)?$/
    );
    assert.equal(scripted.remaining(), 0);
});

test("Chat resource access maps authorization outcomes to domain errors", async () => {
    let selects = 0;
    const dbWithRows = (rows: Record<string, unknown>[]) =>
        ({
            select: () => ({
                from: () => ({
                    where: async () => {
                        selects += 1;
                        return rows;
                    },
                }),
            }),
        }) as never;

    await assert.rejects(
        createChatResourceAccess(dbWithRows([])).authorize({
            userId: "user-1",
            resourceType: "article",
            resourceId: "book-1",
        }),
        (error: unknown) =>
            error instanceof ChatValidationError &&
            error.message === "Unsupported resource type"
    );
    assert.equal(selects, 0);

    await assert.rejects(
        createChatResourceAccess(dbWithRows([])).authorize({
            userId: "user-1",
            resourceType: "book",
            resourceId: "missing",
        }),
        (error: unknown) =>
            error instanceof ChatResourceNotFoundError &&
            error.message === "Book not found"
    );
    await assert.rejects(
        createChatResourceAccess(
            dbWithRows([{ id: "book-1", userId: "owner-2" }])
        ).authorize({
            userId: "user-1",
            resourceType: "book",
            resourceId: "book-1",
        }),
        (error: unknown) =>
            error instanceof ChatResourceAccessDeniedError &&
            error.message === "Book access denied"
    );
});
