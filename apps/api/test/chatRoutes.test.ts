import assert from "node:assert/strict";
import test from "node:test";
import type {
    DbStep,
    RecordedEffect,
    ScriptedDbQueryHandler,
} from "./helpers/httpParity";
import type { User } from "../src/types";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";
process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";
process.env.LANGFUSE_SAMPLE_RATE = "0";
process.env.REDIS_URL = "";

const { ChatController } =
    require("../src/chat/chat.controller") as typeof import("../src/chat/chat.controller");
const { DRIZZLE } =
    require("../src/database/database.module") as typeof import("../src/database/database.module");
const { CHAT_OPERATIONS, createChatOperations, defaultChatStreamDependencies } =
    require("../src/chat/chat-stream") as typeof import("../src/chat/chat-stream");
const { GetBookConversation, ListBookConversations } =
    require("@reader/application") as typeof import("@reader/application");
const {
    createChatResourceAccess,
    createDrizzleChatConversationRepository,
    createDrizzleChatMessageRepository,
} =
    require("../src/infrastructure/chat") as typeof import("../src/infrastructure/chat");
const {
    CHAT_CONVERSATION_REPOSITORY,
    CHAT_MESSAGE_REPOSITORY,
    CHAT_RESOURCE_ACCESS,
    APPEND_BOOK_CHAT,
    GET_BOOK_CONVERSATION,
    START_BOOK_CHAT,
    LIST_BOOK_CONVERSATIONS,
} =
    require("../src/infrastructure/chat/chat.tokens") as typeof import("../src/infrastructure/chat/chat.tokens");
const { RATE_LIMIT_CLIENT } =
    require("../src/common/rate-limit.module") as typeof import("../src/common/rate-limit.module");
const { BOOKS_PORTS } =
    require("../src/books/books.ports") as typeof import("../src/books/books.ports");
const { Books, Conversations, Messages } =
    require("../src/db/schema") as typeof import("../src/db/schema");
const { createTestApp } =
    require("./helpers/nestApp") as typeof import("./helpers/nestApp");
const helper =
    require("./helpers/httpParity") as typeof import("./helpers/httpParity");
const { drizzle } =
    require("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken");

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

type DbRows = {
    bookRows?: unknown[];
    conversationRows?: unknown[];
    messageRows?: unknown[];
};

const createFakeDb = ({
    bookRows = [],
    conversationRows = [],
    messageRows = [],
}: DbRows) => {
    const rowsFor = (table: unknown) => {
        if (table === Books) return bookRows;
        if (table === Conversations) return conversationRows;
        if (table === Messages) return messageRows;
        return [];
    };

    return {
        select: () => ({
            from(table: unknown) {
                return {
                    where() {
                        return Object.assign(Promise.resolve(rowsFor(table)), {
                            orderBy: async () => rowsFor(table),
                        });
                    },
                };
            },
        }),
        insert: (table: unknown) => ({
            values() {
                return {
                    returning: async () => {
                        if (table === Conversations) return [{ id: "conv-1" }];
                        if (table === Messages) return [{ id: "msg-1" }];
                        return [];
                    },
                };
            },
        }),
        update: () => ({
            set() {
                return { where: async () => [] };
            },
        }),
    };
};

const createChatTestApp = (rows: DbRows) => {
    const fakeDb = createFakeDb(rows);
    const resourceAccess = createChatResourceAccess(fakeDb as never);
    const conversations = createDrizzleChatConversationRepository(
        fakeDb as never
    );
    const messages = createDrizzleChatMessageRepository(fakeDb as never);
    const operations = createChatOperations({
        ...defaultChatStreamDependencies,
        db: fakeDb as never,
    });
    return createTestApp({
        controllers: [ChatController],
        providers: [
            { provide: DRIZZLE, useValue: fakeDb },
            {
                provide: CHAT_OPERATIONS,
                useValue: operations,
            },
            { provide: START_BOOK_CHAT, useValue: operations.startBookChat },
            { provide: APPEND_BOOK_CHAT, useValue: operations.appendBookChat },
            {
                provide: CHAT_RESOURCE_ACCESS,
                useValue: resourceAccess,
            },
            {
                provide: CHAT_CONVERSATION_REPOSITORY,
                useValue: conversations,
            },
            {
                provide: CHAT_MESSAGE_REPOSITORY,
                useValue: messages,
            },
            {
                provide: LIST_BOOK_CONVERSATIONS,
                useValue: new ListBookConversations({
                    resourceAccess,
                    conversations,
                }),
            },
            {
                provide: GET_BOOK_CONVERSATION,
                useValue: new GetBookConversation({
                    resourceAccess,
                    conversations,
                    messages,
                }),
            },
            {
                provide: RATE_LIMIT_CLIENT,
                useValue: { get: () => null, close: async () => {} },
            },
        ],
        user: owner,
    });
};

test("POST /api/book/b1/conversations without a message returns 400", async () => {
    const testApp = await createChatTestApp({});
    try {
        const res = await fetch(
            `${testApp.baseUrl}/api/book/b1/conversations`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            }
        );
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Message is required" });
    } finally {
        await testApp.close();
    }
});

test("POST /api/book/b1/conversations with an unsupported model returns 400", async () => {
    const testApp = await createChatTestApp({});
    try {
        const res = await fetch(
            `${testApp.baseUrl}/api/book/b1/conversations`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: "hi", model: "not-a-model" }),
            }
        );
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Unsupported chat model" });
    } finally {
        await testApp.close();
    }
});

test("POST /api/widget/w1/conversations/c1/messages with an unsupported resource type returns 400", async () => {
    const testApp = await createChatTestApp({});
    try {
        const res = await fetch(
            `${testApp.baseUrl}/api/widget/w1/conversations/c1/messages`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: "hi" }),
            }
        );
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Invalid request" });
    } finally {
        await testApp.close();
    }
});

test("GET /api/book/b1/conversations returns 404 when the book is missing", async () => {
    const testApp = await createChatTestApp({ bookRows: [] });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/book/b1/conversations`);
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: "Book not found" });
    } finally {
        await testApp.close();
    }
});

test("GET /api/book/b1/conversations/missing returns 404 when the conversation is missing", async () => {
    const testApp = await createChatTestApp({
        bookRows: [{ id: "b1", userId: owner.id }],
        conversationRows: [],
    });
    try {
        const res = await fetch(
            `${testApp.baseUrl}/api/book/b1/conversations/missing`
        );
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: "Conversation not found" });
    } finally {
        await testApp.close();
    }
});

test("chat-stream exposes the default-operation named exports", () => {
    const chatStream =
        require("../src/chat/chat-stream") as typeof import("../src/chat/chat-stream");
    for (const name of [
        "chatResourceRepository",
        "authorizeRequestResource",
        "findScopedConversation",
        "touchConversation",
        "loadConversationHistory",
        "runChatCompletion",
        "runBookChatTraceIfNeeded",
        "resolveChatModel",
        "defaultChatOperations",
        "createChatOperations",
        "defaultChatStreamDependencies",
        "CHAT_OPERATIONS",
    ] as const) {
        assert.ok(
            chatStream[name] !== undefined,
            `missing chat-stream export ${name}`
        );
    }
    assert.equal(
        typeof chatStream.chatResourceRepository.findBookById,
        "function"
    );
    assert.equal(
        typeof chatStream.chatResourceRepository.createConversation,
        "function"
    );
});

test("legacy chat policy modules re-export the domain function identities", () => {
    const domain = require("@reader/domain") as typeof import("@reader/domain");
    const history =
        require("../src/services/ChatServerHistory") as typeof import("../src/services/ChatServerHistory");
    const highlights =
        require("../src/services/HighlightContext") as typeof import("../src/services/HighlightContext");
    const stream =
        require("../src/chat/chat-stream") as typeof import("../src/chat/chat-stream");

    assert.equal(
        history.getSubmittedUserMessage,
        domain.getSubmittedUserMessage
    );
    assert.equal(history.toChatHistory, domain.selectHistoryWindow);
    assert.equal(
        highlights.normalizeHighlightContext,
        domain.normalizeEpubHighlight
    );
    assert.equal(stream.mapFinishReason, domain.mapFinishReason);
});

test("chat request validation keeps message errors ahead of model errors", async () => {
    const testApp = await createChatTestApp({});
    try {
        const res = await fetch(
            `${testApp.baseUrl}/api/book/b1/conversations`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: "   ",
                    model: "not-a-model",
                }),
            }
        );
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Message is required" });
    } finally {
        await testApp.close();
    }
});

type EffectRecord = Record<string, unknown> & { type: string };

const scriptedState: {
    effects: EffectRecord[];
    dbHandler: ScriptedDbQueryHandler | null;
} = {
    effects: [],
    dbHandler: null,
};

const scriptedRecord = (effect: RecordedEffect) => {
    scriptedState.effects.push(effect);
};

const scriptedPgClient = {
    query: async (queryConfig: unknown, params?: unknown[]) => {
        if (!scriptedState.dbHandler) {
            throw new Error("db query without scripted handler");
        }
        const sqlText =
            typeof queryConfig === "string"
                ? queryConfig
                : (queryConfig as { text?: string } | null | undefined)?.text;
        const result = await scriptedState.dbHandler(queryConfig, params);
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
    connect: async () => scriptedPgClient,
    release: () => undefined,
    end: async () => undefined,
};
const scriptedDb = drizzle(scriptedPgClient as never);

const unexpectedExternal = (target: string) =>
    (async () => {
        scriptedRecord({ type: "external", target, unexpected: true });
        throw new Error(`Unexpected external call: ${target}`);
    }) as never;

const scriptedChatOperations = createChatOperations({
    ...defaultChatStreamDependencies,
    db: scriptedDb as never,
    retrieveBookContext: unexpectedExternal("chat.retrieveBookContext"),
    generateBookAnswer: unexpectedExternal("chat.generateBookAnswer"),
    maybeEnqueueRagRerankShadow: unexpectedExternal(
        "queue.rag-rerank-shadow.add"
    ),
});

const createScriptedChatApp = (steps: DbStep[]) => {
    scriptedState.effects = [];
    scriptedState.dbHandler = helper.createScriptedDbQueryHandler(
        steps,
        scriptedRecord
    );
    return createTestApp({
        fullStack: true,
        db: scriptedDb,
        overrides: [
            {
                token: RATE_LIMIT_CLIENT,
                useValue: { get: () => null, close: async () => undefined },
            },
            { token: CHAT_OPERATIONS, useValue: scriptedChatOperations },
            {
                token: START_BOOK_CHAT,
                useValue: scriptedChatOperations.startBookChat,
            },
            {
                token: APPEND_BOOK_CHAT,
                useValue: scriptedChatOperations.appendBookChat,
            },
            {
                token: BOOKS_PORTS,
                useValue: {
                    uploadFile: unexpectedExternal("storage.uploadFile"),
                    deleteFile: unexpectedExternal("storage.deleteFile"),
                    deleteVectorCollection: unexpectedExternal(
                        "vectorStore.deleteCollection"
                    ),
                    deleteCollectionChunks: unexpectedExternal(
                        "bookSearchChunks.deleteCollection"
                    ),
                    clearCollectionCache: unexpectedExternal(
                        "hybridBookSearch.clearCollectionCache"
                    ),
                    enqueueBookProcessing: unexpectedExternal(
                        "queue.book-processing.add"
                    ),
                    bookFile: {
                        findBookById: unexpectedExternal("books.findBookById"),
                        getFile: unexpectedExternal("storage.getFile"),
                    },
                },
            },
        ],
    });
};

const AUTHED_USER_STEP: DbStep = {
    op: "select",
    table: "users",
    rows: [helper.OWNER_ROW],
};
const BOOK_REF_STEP = (userId: string): DbStep => ({
    op: "select",
    table: "books",
    rows: [{ id: "book-1", user_id: userId }],
});

const validSessionCookie = `reader_session=${jwt.sign(
    { userId: helper.OWNER.id },
    helper.JWT_SECRET,
    { expiresIn: "7d" }
)}`;

const authedPost = (
    baseUrl: string,
    pathName: string,
    body: unknown,
    cookie = validSessionCookie
) =>
    fetch(`${baseUrl}${pathName}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: helper.FRONTEND_URL,
            ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
    });

const authedGet = (baseUrl: string, pathName: string) =>
    fetch(`${baseUrl}${pathName}`, {
        headers: { cookie: validSessionCookie },
    });

test("POST create conversation rejects non-owner book with 403 and writes nothing", async () => {
    const testApp = await createScriptedChatApp([
        AUTHED_USER_STEP,
        BOOK_REF_STEP("other-user-1"),
    ]);
    try {
        const res = await authedPost(
            testApp.baseUrl,
            "/api/book/book-1/conversations",
            { message: "Question?" }
        );
        assert.equal(res.status, 403);
        assert.deepEqual(await res.json(), { error: "Book access denied" });
        assert.deepEqual(
            scriptedState.effects.map((e) => `${e.operation}:${e.table}`),
            ["select:users", "select:books"]
        );
        const bookQuery = scriptedState.effects[1];
        assert.equal(
            bookQuery.sql,
            'select "id", "user_id" from "books" where "books"."id" = $1'
        );
        assert.deepEqual(bookQuery.params, ["book-1"]);
    } finally {
        await testApp.close();
    }
});

test("POST create conversation rejects a missing book with 404 and writes nothing", async () => {
    const testApp = await createScriptedChatApp([
        AUTHED_USER_STEP,
        { op: "select", table: "books", rows: [] },
    ]);
    try {
        const res = await authedPost(
            testApp.baseUrl,
            "/api/book/book-1/conversations",
            { message: "Question?" }
        );
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: "Book not found" });
        assert.equal(scriptedState.effects.length, 2);
        assert.ok(
            scriptedState.effects.every(
                (effect) => effect.operation === "select"
            )
        );
    } finally {
        await testApp.close();
    }
});

test("POST create conversation with unsupported resource type returns the authorization body", async () => {
    const testApp = await createScriptedChatApp([AUTHED_USER_STEP]);
    try {
        const res = await authedPost(
            testApp.baseUrl,
            "/api/widget/widget-1/conversations",
            { message: "Question?" }
        );
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), {
            error: "Unsupported resource type",
        });
        assert.equal(scriptedState.effects.length, 1);
    } finally {
        await testApp.close();
    }
});

test("POST create conversation without a session cookie returns 401", async () => {
    const testApp = await createScriptedChatApp([]);
    try {
        const res = await authedPost(
            testApp.baseUrl,
            "/api/book/book-1/conversations",
            { message: "Question?" },
            ""
        );
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { message: "No token provided" });
        assert.equal(scriptedState.effects.length, 0);
    } finally {
        await testApp.close();
    }
});

test("POST create conversation rejects a message over 8000 characters", async () => {
    const testApp = await createScriptedChatApp([AUTHED_USER_STEP]);
    try {
        const res = await authedPost(
            testApp.baseUrl,
            "/api/book/book-1/conversations",
            { message: "x".repeat(8001) }
        );
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Message is required" });
    } finally {
        await testApp.close();
    }
});

test("POST append message with unsupported resource type returns 400 Invalid request", async () => {
    const testApp = await createScriptedChatApp([AUTHED_USER_STEP]);
    try {
        const res = await authedPost(
            testApp.baseUrl,
            "/api/widget/widget-1/conversations/conv-1/messages",
            { message: "Question?" }
        );
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Invalid request" });
        assert.equal(scriptedState.effects.length, 1);
    } finally {
        await testApp.close();
    }
});

test("POST append message to a conversation outside the owner/book scope returns 404", async () => {
    const testApp = await createScriptedChatApp([
        AUTHED_USER_STEP,
        BOOK_REF_STEP(helper.OWNER.id),
        { op: "select", table: "conversations", rows: [] },
    ]);
    try {
        const res = await authedPost(
            testApp.baseUrl,
            "/api/book/book-1/conversations/conv-other/messages",
            { message: "Question?" }
        );
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: "Conversation not found" });
        const scopeQuery = scriptedState.effects[2];
        assert.equal(scopeQuery.operation, "select");
        assert.equal(scopeQuery.table, "conversations");
        assert.deepEqual(scopeQuery.params, [
            "conv-other",
            helper.OWNER.id,
            "book",
            "book-1",
        ]);
        assert.equal(scriptedState.effects.length, 3);
    } finally {
        await testApp.close();
    }
});

test("POST append message with a blank message returns 400 before any writes", async () => {
    const testApp = await createScriptedChatApp([AUTHED_USER_STEP]);
    try {
        const res = await authedPost(
            testApp.baseUrl,
            "/api/book/book-1/conversations/conv-1/messages",
            { message: "   " }
        );
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Message is required" });
        assert.equal(scriptedState.effects.length, 1);
    } finally {
        await testApp.close();
    }
});

test("POST append message with an unsupported model returns 400 before any writes", async () => {
    const testApp = await createScriptedChatApp([AUTHED_USER_STEP]);
    try {
        const res = await authedPost(
            testApp.baseUrl,
            "/api/book/book-1/conversations/conv-1/messages",
            { message: "Question?", model: "gpt-99-turbo" }
        );
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), {
            error: "Unsupported chat model",
        });
        assert.equal(scriptedState.effects.length, 1);
    } finally {
        await testApp.close();
    }
});

const CONVERSATION_ROW_A = {
    id: "conv-a",
    user_id: helper.OWNER.id,
    title: "First",
    created_at: "2024-01-01T00:00:00.000Z",
    last_message_at: "2024-01-03T00:00:00.000Z",
    resource_type: "book",
    resource_id: "book-1",
};
const CONVERSATION_ROW_B = {
    ...CONVERSATION_ROW_A,
    id: "conv-b",
    title: "Second",
    last_message_at: "2024-01-02T00:00:00.000Z",
};

test("GET conversations lists rows ordered by lastMessageAt DESC", async () => {
    const testApp = await createScriptedChatApp([
        AUTHED_USER_STEP,
        BOOK_REF_STEP(helper.OWNER.id),
        {
            op: "select",
            table: "conversations",
            rows: [CONVERSATION_ROW_A, CONVERSATION_ROW_B],
        },
    ]);
    try {
        const res = await authedGet(
            testApp.baseUrl,
            "/api/book/book-1/conversations"
        );
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
            conversations: Array<Record<string, unknown>>;
        };
        assert.equal(body.conversations.length, 2);
        assert.equal(body.conversations[0].id, "conv-a");
        assert.equal(body.conversations[0].userId, helper.OWNER.id);
        const listQuery = scriptedState.effects[2];
        assert.equal(listQuery.operation, "select");
        assert.equal(listQuery.table, "conversations");
        assert.match(
            listQuery.sql as string,
            /order by "conversations"\."last_message_at" desc/
        );
        assert.deepEqual(listQuery.params, [helper.OWNER.id, "book", "book-1"]);
    } finally {
        await testApp.close();
    }
});

test("GET conversation messages selects public columns only and orders ASC", async () => {
    const testApp = await createScriptedChatApp([
        AUTHED_USER_STEP,
        BOOK_REF_STEP(helper.OWNER.id),
        {
            op: "select",
            table: "conversations",
            rows: [CONVERSATION_ROW_A],
        },
        {
            op: "select",
            table: "messages",
            rows: [
                {
                    id: "msg-1",
                    conversation_id: "conv-a",
                    role: "user",
                    content: "Question?",
                    context_sources: null,
                    completion_status: null,
                    finish_reason: null,
                    created_at: "2024-01-01T00:00:00.000Z",
                },
            ],
        },
    ]);
    try {
        const res = await authedGet(
            testApp.baseUrl,
            "/api/book/book-1/conversations/conv-a"
        );
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
            messages: Array<Record<string, unknown>>;
        };
        assert.equal(body.messages.length, 1);
        assert.equal(body.messages[0].id, "msg-1");
        assert.equal(body.messages[0].content, "Question?");
        assert.ok(!("executionMetadata" in body.messages[0]));
        const messageQuery = scriptedState.effects[3];
        assert.equal(messageQuery.operation, "select");
        assert.equal(messageQuery.table, "messages");
        assert.ok(
            !(messageQuery.sql as string).includes("execution_metadata"),
            "public message selection must not read execution_metadata"
        );
        assert.match(
            messageQuery.sql as string,
            /order by "messages"\."created_at"( asc)?$/
        );
        assert.deepEqual(messageQuery.params, ["conv-a"]);
        const scopeQuery = scriptedState.effects[2];
        assert.deepEqual(scopeQuery.params, [
            "conv-a",
            helper.OWNER.id,
            "book",
            "book-1",
        ]);
    } finally {
        await testApp.close();
    }
});
