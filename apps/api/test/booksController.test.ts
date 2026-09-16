import assert from "node:assert/strict";
import test from "node:test";
import type { User } from "../src/types";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";

const { BooksController } =
    require("../src/books/books.controller") as typeof import("../src/books/books.controller");
const { DRIZZLE } =
    require("../src/database/database.module") as typeof import("../src/database/database.module");
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

const createDbMock = (bookRows: unknown[] = []) => ({
    select() {
        return {
            from() {
                return { where: async () => bookRows };
            },
        };
    },
    update() {
        return {
            set() {
                return { where: async () => [] };
            },
        };
    },
});

const createBooksTestApp = (db: unknown) =>
    createTestApp({
        controllers: [BooksController],
        providers: [{ provide: DRIZZLE, useValue: db }],
        user: owner,
    });

test("POST /api/books without a file returns 400", async () => {
    const testApp = await createBooksTestApp(createDbMock());
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books`, {
            method: "POST",
        });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "No file uploaded" });
    } finally {
        await testApp.close();
    }
});

test("POST /api/books/:id/retry returns 409 for a non-retryable book", async () => {
    const testApp = await createBooksTestApp(
        createDbMock([
            {
                id: "book-1",
                userId: "owner-1",
                fileKey: "key-1",
                fileType: "epub",
                processingStatus: "ready",
            },
        ])
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1/retry`, {
            method: "POST",
        });
        assert.equal(res.status, 409);
        assert.deepEqual(await res.json(), { error: "Book is not retryable" });
    } finally {
        await testApp.close();
    }
});

test("GET /api/books/:id/status returns 403 for a non-owner", async () => {
    const testApp = await createBooksTestApp(
        createDbMock([
            {
                id: "book-1",
                userId: "someone-else",
                fileKey: "key-1",
                fileType: "epub",
                processingStatus: "ready",
            },
        ])
    );
    try {
        const res = await fetch(`${testApp.baseUrl}/api/books/book-1/status`);
        assert.equal(res.status, 403);
        assert.deepEqual(await res.json(), { error: "Not authorized" });
    } finally {
        await testApp.close();
    }
});
