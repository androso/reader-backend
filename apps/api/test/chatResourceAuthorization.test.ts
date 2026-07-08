import assert from "node:assert/strict";
import test from "node:test";
import {
    authorizeChatResource,
    isSupportedChatResourceType,
    type ChatResourceAuthorizationRepository,
} from "../src/services/ChatResourceAuthorization";

const createRepository = (
    book: Awaited<
        ReturnType<ChatResourceAuthorizationRepository["findBookById"]>
    >
): ChatResourceAuthorizationRepository => ({
    findBookById: async () => book,
});

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

test("rejects nonexistent book conversation creation", async () => {
    const result = await authorizeChatResource({
        resourceType: "book",
        resourceId: "book-1",
        userId: "user-1",
        repository: createRepository(null),
    });

    assert.deepEqual(result, {
        ok: false,
        status: 404,
        error: "Book not found",
    });
});

test("rejects unauthorized book conversation creation", async () => {
    const result = await authorizeChatResource({
        resourceType: "book",
        resourceId: "book-1",
        userId: "user-1",
        repository: createRepository({
            id: "book-1",
            userId: "user-2",
        }),
    });

    assert.deepEqual(result, {
        ok: false,
        status: 403,
        error: "Book access denied",
    });
});

test("allows owned book conversation creation", async () => {
    const result = await authorizeChatResource({
        resourceType: "book",
        resourceId: "book-1",
        userId: "user-1",
        repository: createRepository({
            id: "book-1",
            userId: "user-1",
        }),
    });

    assert.deepEqual(result, {
        ok: true,
        resourceType: "book",
    });
});
