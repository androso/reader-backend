import assert from "node:assert/strict";
import test from "node:test";
import {
    authorizeChatResource,
    createAuthorizedChatConversation,
    isSupportedChatResourceType,
    type ChatResourceAuthorizationRepository,
    type CreateChatConversationRepository,
} from "../src/services/ChatResourceAuthorization";

const createRepository = (
    book: Awaited<
        ReturnType<ChatResourceAuthorizationRepository["findBookById"]>
    >
): ChatResourceAuthorizationRepository => ({
    findBookById: async () => book,
});

const createConversationRepository = (
    book: Awaited<
        ReturnType<ChatResourceAuthorizationRepository["findBookById"]>
    >
) => {
    const inserts: Array<{
        userId: string;
        title: string;
        resourceType: "book";
        resourceId: string;
    }> = [];
    const repository: CreateChatConversationRepository = {
        findBookById: async () => book,
        createConversation: async (input) => {
            inserts.push(input);
            return { id: "conversation-1" };
        },
    };

    return { repository, inserts };
};

test("rejects unsupported chat resource types", async () => {
    assert.equal(isSupportedChatResourceType("book"), true);
    assert.equal(isSupportedChatResourceType("article"), false);
    assert.equal(isSupportedChatResourceType("podcast"), false);

    const result = await authorizeChatResource({
        resourceType: "article",
        resourceId: "article-1",
        userId: "user-1",
        repository: createRepository(null),
    });

    assert.deepEqual(result, {
        ok: false,
        status: 400,
        error: "Unsupported resource type",
    });
});

test("nonexistent book does not insert a conversation", async () => {
    const { repository, inserts } = createConversationRepository(null);
    const result = await createAuthorizedChatConversation({
        resourceType: "book",
        resourceId: "book-1",
        userId: "user-1",
        title: "Question...",
        repository,
    });

    assert.deepEqual(result, {
        ok: false,
        status: 404,
        error: "Book not found",
    });
    assert.deepEqual(inserts, []);
});

test("unauthorized book does not insert a conversation", async () => {
    const { repository, inserts } = createConversationRepository({
        id: "book-1",
        userId: "user-2",
    });
    const result = await createAuthorizedChatConversation({
        resourceType: "book",
        resourceId: "book-1",
        userId: "user-1",
        title: "Question...",
        repository,
    });

    assert.deepEqual(result, {
        ok: false,
        status: 403,
        error: "Book access denied",
    });
    assert.deepEqual(inserts, []);
});

test("owned book inserts one scoped conversation", async () => {
    const { repository, inserts } = createConversationRepository({
        id: "book-1",
        userId: "user-1",
    });
    const result = await createAuthorizedChatConversation({
        resourceType: "book",
        resourceId: "book-1",
        userId: "user-1",
        title: "Question...",
        repository,
    });

    assert.deepEqual(result, {
        ok: true,
        resourceType: "book",
        conversation: { id: "conversation-1" },
    });
    assert.deepEqual(inserts, [
        {
            userId: "user-1",
            title: "Question...",
            resourceType: "book",
            resourceId: "book-1",
        },
    ]);
});
