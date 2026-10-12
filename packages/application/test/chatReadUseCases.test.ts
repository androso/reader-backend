import assert from "node:assert/strict";
import test from "node:test";
import {
    ChatConversationNotFoundError,
    ChatResourceAccessDeniedError,
    ChatResourceNotFoundError,
    ChatValidationError,
    type ChatConversation,
    type ChatMessage,
} from "@reader/domain";
import { GetBookConversation, ListBookConversations } from "../src";
import type {
    ChatConversationRepository,
    ChatMessageRepository,
    ChatResourceAccess,
} from "../src";

const conversation: ChatConversation = {
    id: "conversation-1",
    userId: "user-1",
    title: "A title",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    lastMessageAt: new Date("2024-01-02T00:00:00.000Z"),
    resourceType: "book",
    resourceId: "book-1",
};

const messages: ChatMessage[] = [
    {
        id: "message-1",
        conversationId: conversation.id,
        role: "user",
        content: "Question",
        contextSources: null,
        completionStatus: null,
        finishReason: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
];

const request = {
    userId: "user-1",
    resourceType: "book",
    resourceId: "book-1",
    conversationId: conversation.id,
};

test("ListBookConversations authorizes and returns scoped conversations", async () => {
    const calls: unknown[] = [];
    const rows = [conversation];
    const result = await new ListBookConversations({
        resourceAccess: {
            authorize: async (input) => {
                calls.push(["authorize", input]);
                return { resourceType: "book" };
            },
        },
        conversations: {
            listScoped: async (input) => {
                calls.push(["list", input]);
                return rows;
            },
        },
    }).execute(request);

    assert.deepEqual(calls, [
        [
            "authorize",
            {
                userId: request.userId,
                resourceType: request.resourceType,
                resourceId: request.resourceId,
            },
        ],
        [
            "list",
            {
                userId: request.userId,
                resourceType: "book",
                resourceId: request.resourceId,
            },
        ],
    ]);
    assert.deepEqual(result, rows);
});

test("GetBookConversation authorizes, scopes, then returns public messages", async () => {
    const calls: unknown[] = [];
    const result = await new GetBookConversation({
        resourceAccess: {
            authorize: async (input) => {
                calls.push(["authorize", input]);
                return { resourceType: "book" };
            },
        },
        conversations: {
            findScoped: async (input) => {
                calls.push(["find", input]);
                return conversation;
            },
        },
        messages: {
            listForConversation: async (conversationId) => {
                calls.push(["messages", conversationId]);
                return messages;
            },
        },
    }).execute(request);

    assert.deepEqual(calls, [
        [
            "authorize",
            {
                userId: request.userId,
                resourceType: request.resourceType,
                resourceId: request.resourceId,
            },
        ],
        [
            "find",
            {
                conversationId: request.conversationId,
                userId: request.userId,
                resourceType: "book",
                resourceId: request.resourceId,
            },
        ],
        ["messages", request.conversationId],
    ]);
    assert.deepEqual(result, messages);
});

const deniedResourceAccess = (error: Error): ChatResourceAccess => ({
    authorize: async () => {
        throw error;
    },
});

test("chat read workflows propagate unsupported resource type", async () => {
    const unsupported = new ChatValidationError(
        "unsupported_resource_type",
        "Unsupported resource type"
    );
    const list = new ListBookConversations({
        resourceAccess: deniedResourceAccess(unsupported),
        conversations: {
            listScoped: async () => {
                throw new Error("conversation repository should not be called");
            },
        },
    });
    const get = new GetBookConversation({
        resourceAccess: deniedResourceAccess(unsupported),
        conversations: {
            findScoped: async () => {
                throw new Error("conversation repository should not be called");
            },
        },
        messages: {
            listForConversation: async () => {
                throw new Error("message repository should not be called");
            },
        },
    });

    await assert.rejects(
        list.execute(request),
        (error: unknown) =>
            error instanceof ChatValidationError &&
            error.message === "Unsupported resource type"
    );
    await assert.rejects(
        get.execute(request),
        (error: unknown) =>
            error instanceof ChatValidationError &&
            error.message === "Unsupported resource type"
    );
});

test("chat read workflows propagate missing resource errors", async () => {
    const missing = new ChatResourceNotFoundError();
    const list = new ListBookConversations({
        resourceAccess: deniedResourceAccess(missing),
        conversations: { listScoped: async () => [] },
    });
    const get = new GetBookConversation({
        resourceAccess: deniedResourceAccess(missing),
        conversations: { findScoped: async () => conversation },
        messages: { listForConversation: async () => messages },
    });

    await assert.rejects(list.execute(request), ChatResourceNotFoundError);
    await assert.rejects(get.execute(request), ChatResourceNotFoundError);
});

test("chat read workflows propagate access denied errors", async () => {
    const denied = new ChatResourceAccessDeniedError();
    const list = new ListBookConversations({
        resourceAccess: deniedResourceAccess(denied),
        conversations: { listScoped: async () => [] },
    });
    const get = new GetBookConversation({
        resourceAccess: deniedResourceAccess(denied),
        conversations: { findScoped: async () => conversation },
        messages: { listForConversation: async () => messages },
    });

    await assert.rejects(list.execute(request), ChatResourceAccessDeniedError);
    await assert.rejects(get.execute(request), ChatResourceAccessDeniedError);
});

test("GetBookConversation treats a missing scoped conversation as not found", async () => {
    const useCase = new GetBookConversation({
        resourceAccess: {
            authorize: async () => ({ resourceType: "book" }),
        },
        conversations: { findScoped: async () => null },
        messages: {
            listForConversation: async () => {
                throw new Error("message repository should not be called");
            },
        },
    });

    await assert.rejects(
        useCase.execute(request),
        ChatConversationNotFoundError
    );
});

test("chat authorization is checked before conversation or message repositories", async () => {
    const calls: string[] = [];
    const access: ChatResourceAccess = {
        authorize: async () => {
            calls.push("authorize");
            throw new ChatResourceAccessDeniedError();
        },
    };
    const conversations: Pick<
        ChatConversationRepository,
        "listScoped" | "findScoped"
    > = {
        listScoped: async () => {
            calls.push("list");
            return [];
        },
        findScoped: async () => {
            calls.push("find");
            return conversation;
        },
    };
    const messageRepository: Pick<
        ChatMessageRepository,
        "listForConversation"
    > = {
        listForConversation: async () => {
            calls.push("messages");
            return messages;
        },
    };

    await assert.rejects(
        new ListBookConversations({
            resourceAccess: access,
            conversations,
        }).execute(request),
        ChatResourceAccessDeniedError
    );
    await assert.rejects(
        new GetBookConversation({
            resourceAccess: access,
            conversations,
            messages: messageRepository,
        }).execute(request),
        ChatResourceAccessDeniedError
    );
    assert.deepEqual(calls, ["authorize", "authorize"]);
});
