import assert from "node:assert/strict";
import test from "node:test";
import type { User } from "../src/types";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";
process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

const { ChatController } =
    require("../src/chat/chat.controller") as typeof import("../src/chat/chat.controller");
const { DRIZZLE } =
    require("../src/database/database.module") as typeof import("../src/database/database.module");
const { CHAT_OPERATIONS } =
    require("../src/chat/chat-stream") as typeof import("../src/chat/chat-stream");
const { RATE_LIMIT_CLIENT } =
    require("../src/common/rate-limit.module") as typeof import("../src/common/rate-limit.module");
const {
    APPEND_BOOK_CHAT,
    CHAT_RESOURCE_ACCESS,
    CHAT_CONVERSATION_REPOSITORY,
    CHAT_MESSAGE_REPOSITORY,
    LIST_BOOK_CONVERSATIONS,
    GET_BOOK_CONVERSATION,
    START_BOOK_CHAT,
} =
    require("../src/infrastructure/chat/chat.tokens") as typeof import("../src/infrastructure/chat/chat.tokens");
const {
    ChatConversationNotFoundError,
    ChatResourceAccessDeniedError,
    ChatResourceNotFoundError,
    ChatValidationError,
} = require("@reader/domain") as typeof import("@reader/domain");
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

const createReadTestApp = ({
    listExecute = async () => [],
    getExecute = async () => [],
}: {
    listExecute?: (input: {
        userId: string;
        resourceType: string;
        resourceId: string;
    }) => Promise<unknown>;
    getExecute?: (input: {
        userId: string;
        resourceType: string;
        resourceId: string;
        conversationId: string;
    }) => Promise<unknown>;
} = {}) =>
    createTestApp({
        controllers: [ChatController],
        providers: [
            { provide: DRIZZLE, useValue: {} },
            { provide: CHAT_OPERATIONS, useValue: {} },
            {
                provide: START_BOOK_CHAT,
                useValue: {
                    prepare: async () => ({}),
                    executePrepared: async () => {},
                },
            },
            {
                provide: APPEND_BOOK_CHAT,
                useValue: {
                    prepare: async () => ({}),
                    executePrepared: async () => {},
                },
            },
            {
                provide: RATE_LIMIT_CLIENT,
                useValue: { get: () => null, close: async () => {} },
            },
            { provide: CHAT_RESOURCE_ACCESS, useValue: {} },
            { provide: CHAT_CONVERSATION_REPOSITORY, useValue: {} },
            { provide: CHAT_MESSAGE_REPOSITORY, useValue: {} },
            {
                provide: LIST_BOOK_CONVERSATIONS,
                useValue: { execute: listExecute },
            },
            {
                provide: GET_BOOK_CONVERSATION,
                useValue: { execute: getExecute },
            },
        ],
        user: owner,
        overrides: [
            {
                token: LIST_BOOK_CONVERSATIONS,
                useValue: { execute: listExecute },
            },
            {
                token: GET_BOOK_CONVERSATION,
                useValue: { execute: getExecute },
            },
        ],
    });

test("chat GET controllers preserve the response wrappers from their use cases", async () => {
    const conversations = [{ id: "conversation-1", resourceType: "book" }];
    const messages = [{ id: "message-1", content: "Answer" }];
    const calls: unknown[] = [];
    const app = await createReadTestApp({
        listExecute: async (input) => {
            calls.push(["list", input]);
            return conversations;
        },
        getExecute: async (input) => {
            calls.push(["get", input]);
            return messages;
        },
    });

    try {
        const listResponse = await fetch(
            `${app.baseUrl}/api/book/book-1/conversations`
        );
        assert.equal(listResponse.status, 200);
        assert.deepEqual(await listResponse.json(), { conversations });

        const getResponse = await fetch(
            `${app.baseUrl}/api/book/book-1/conversations/conversation-1`
        );
        assert.equal(getResponse.status, 200);
        assert.deepEqual(await getResponse.json(), { messages });
        assert.deepEqual(calls, [
            [
                "list",
                {
                    userId: owner.id,
                    resourceType: "book",
                    resourceId: "book-1",
                },
            ],
            [
                "get",
                {
                    userId: owner.id,
                    resourceType: "book",
                    resourceId: "book-1",
                    conversationId: "conversation-1",
                },
            ],
        ]);
    } finally {
        await app.close();
    }
});

const mappedErrorCases = [
    {
        name: "unsupported resource type",
        route: "list",
        error: () =>
            new ChatValidationError(
                "unsupported_resource_type",
                "Unsupported resource type"
            ),
        status: 400,
        body: { error: "Unsupported resource type" },
    },
    {
        name: "missing book",
        route: "list",
        error: () => new ChatResourceNotFoundError(),
        status: 404,
        body: { error: "Book not found" },
    },
    {
        name: "book access denied",
        route: "list",
        error: () => new ChatResourceAccessDeniedError(),
        status: 403,
        body: { error: "Book access denied" },
    },
    {
        name: "conversation out of scope",
        route: "get",
        error: () => new ChatConversationNotFoundError(),
        status: 404,
        body: { error: "Conversation not found" },
    },
] as const;

for (const errorCase of mappedErrorCases) {
    test(`chat GET controllers map ${errorCase.name} to the existing HTTP response`, async () => {
        const reject = async (): Promise<never> => {
            throw errorCase.error();
        };
        const app = await createReadTestApp({
            listExecute: errorCase.route === "list" ? reject : async () => [],
            getExecute: errorCase.route === "get" ? reject : async () => [],
        });

        try {
            const path =
                errorCase.route === "list"
                    ? "/api/book/book-1/conversations"
                    : "/api/book/book-1/conversations/conversation-1";
            const response = await fetch(`${app.baseUrl}${path}`);
            assert.equal(response.status, errorCase.status);
            assert.deepEqual(await response.json(), errorCase.body);
        } finally {
            await app.close();
        }
    });
}

test("chat GET controllers retain their route-specific unexpected-error responses", async () => {
    for (const route of ["list", "get"] as const) {
        const reject = async (): Promise<never> => {
            throw new Error("unexpected failure");
        };
        const app = await createReadTestApp({
            listExecute: route === "list" ? reject : async () => [],
            getExecute: route === "get" ? reject : async () => [],
        });

        try {
            const path =
                route === "list"
                    ? "/api/book/book-1/conversations"
                    : "/api/book/book-1/conversations/conversation-1";
            const response = await fetch(`${app.baseUrl}${path}`);
            assert.equal(response.status, 500);
            assert.deepEqual(await response.json(), {
                error:
                    route === "list"
                        ? "An error occurred while fetching conversations"
                        : "An error occurred while retrieving conversation details",
            });
        } finally {
            await app.close();
        }
    }
});
