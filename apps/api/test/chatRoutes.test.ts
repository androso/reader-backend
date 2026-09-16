import assert from "node:assert/strict";
import test from "node:test";
import type { User } from "../src/types";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";

const { ChatController } =
    require("../src/chat/chat.controller") as typeof import("../src/chat/chat.controller");
const { DRIZZLE } =
    require("../src/database/database.module") as typeof import("../src/database/database.module");
const { db } = require("../src/db") as typeof import("../src/db");
const { Books, Conversations, Messages } =
    require("../src/db/schema") as typeof import("../src/db/schema");
const { createTestApp } =
    require("./helpers/nestApp") as typeof import("./helpers/nestApp");

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

const patchDb = ({
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

    const dbMock = db as unknown as {
        select: unknown;
        insert: unknown;
        update: unknown;
    };
    const originals = {
        select: dbMock.select,
        insert: dbMock.insert,
        update: dbMock.update,
    };

    dbMock.select = () => ({
        from(table: unknown) {
            return {
                where() {
                    return Object.assign(Promise.resolve(rowsFor(table)), {
                        orderBy: async () => rowsFor(table),
                    });
                },
            };
        },
    });
    dbMock.insert = (table: unknown) => ({
        values() {
            return {
                returning: async () => {
                    if (table === Conversations) return [{ id: "conv-1" }];
                    if (table === Messages) return [{ id: "msg-1" }];
                    return [];
                },
            };
        },
    });
    dbMock.update = () => ({
        set() {
            return { where: async () => [] };
        },
    });

    return () => {
        dbMock.select = originals.select;
        dbMock.insert = originals.insert;
        dbMock.update = originals.update;
    };
};

const createChatTestApp = (rows: DbRows) => {
    const restore = patchDb(rows);
    return createTestApp({
        controllers: [ChatController],
        providers: [{ provide: DRIZZLE, useValue: db }],
        user: owner,
    }).then((testApp) => ({
        ...testApp,
        close: async () => {
            try {
                await testApp.close();
            } finally {
                restore();
            }
        },
    }));
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
