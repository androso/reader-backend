import assert from "node:assert/strict";
import test from "node:test";
import type { User } from "../src/types";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";

const { TrackerController } =
    require("../src/tracker/tracker.controller") as typeof import("../src/tracker/tracker.controller");
const { DRIZZLE } =
    require("../src/database/database.module") as typeof import("../src/database/database.module");
const { Books, Progress } =
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

type ProgressMutationValues = {
    createdAt?: Date;
    updatedAt?: Date;
    [key: string]: unknown;
};

const createDbMock = ({
    bookRows = [],
    progressRows = [],
}: {
    bookRows?: unknown[];
    progressRows?: unknown[];
}) => {
    const calls = {
        insertedValues: null as ProgressMutationValues | null,
    };

    const db = {
        select() {
            return {
                from(table: unknown) {
                    return {
                        where: async () => {
                            if (table === Books) return bookRows;
                            if (table === Progress) return progressRows;
                            return [];
                        },
                    };
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
        insert(table: unknown) {
            return {
                values(values: ProgressMutationValues) {
                    calls.insertedValues = values;
                    return {
                        onConflictDoUpdate() {
                            return {
                                returning: async () =>
                                    table === Progress
                                        ? [
                                              {
                                                  id: "inserted-progress",
                                                  ...values,
                                              },
                                          ]
                                        : [],
                            };
                        },
                    };
                },
            };
        },
    };

    return { db, calls };
};

test("rejects unauthenticated progress access", async () => {
    const { db } = createDbMock({});
    const testApp = await createTestApp({
        controllers: [TrackerController],
        providers: [{ provide: DRIZZLE, useValue: db }],
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/book-1/progress`);
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { message: "No token provided" });
    } finally {
        await testApp.close();
    }
});

test("returns 404 for a non-owner book id without reading progress", async () => {
    const { db } = createDbMock({ bookRows: [] });
    const testApp = await createTestApp({
        controllers: [TrackerController],
        providers: [{ provide: DRIZZLE, useValue: db }],
        user: owner,
    });
    try {
        const res = await fetch(
            `${testApp.baseUrl}/api/someone-elses-book/progress`
        );
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { message: "Book not found" });
    } finally {
        await testApp.close();
    }
});

test("returns 404 for a missing owned book id", async () => {
    const { db } = createDbMock({ bookRows: [] });
    const testApp = await createTestApp({
        controllers: [TrackerController],
        providers: [{ provide: DRIZZLE, useValue: db }],
        user: owner,
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/missing-book/progress`);
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { message: "Book not found" });
    } finally {
        await testApp.close();
    }
});

test("returns owner progress for an owned book id", async () => {
    const { db } = createDbMock({
        bookRows: [{ id: "book-1", userId: "owner-1" }],
        progressRows: [
            {
                bookId: "book-1",
                userId: "owner-1",
                progressPosition: "c01-block-1",
                progressChapter: "c01",
            },
        ],
    });
    const testApp = await createTestApp({
        controllers: [TrackerController],
        providers: [{ provide: DRIZZLE, useValue: db }],
        user: owner,
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/book-1/progress`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), {
            progressPosition: "c01-block-1",
            progressChapter: "c01",
        });
    } finally {
        await testApp.close();
    }
});

test("writes owner progress for an owned book id", async () => {
    const { db, calls } = createDbMock({
        bookRows: [{ id: "book-1", userId: "owner-1" }],
        progressRows: [],
    });
    const testApp = await createTestApp({
        controllers: [TrackerController],
        providers: [{ provide: DRIZZLE, useValue: db }],
        user: owner,
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/book-1/progress`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                progress_block: "c01-block-2",
                progress_chapter: "c01",
            }),
        });
        assert.equal(res.status, 201);
        const body = await res.json();
        assert.equal(body.message, "Progress saved");
        assert.equal(body.data.id, "inserted-progress");
        assert.equal(body.data.userId, "owner-1");
        assert.equal(body.data.bookId, "book-1");
        assert.equal(body.data.progressPosition, "c01-block-2");
        assert.equal(body.data.progressChapter, "c01");
        assert.equal(
            body.data.createdAt,
            calls.insertedValues!.createdAt!.toISOString()
        );
        assert.equal(
            body.data.updatedAt,
            calls.insertedValues!.updatedAt!.toISOString()
        );
    } finally {
        await testApp.close();
    }
});

test("GET /api/progress is not exposed", async () => {
    const { db } = createDbMock({});
    const testApp = await createTestApp({
        controllers: [TrackerController],
        providers: [{ provide: DRIZZLE, useValue: db }],
        user: owner,
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/progress`);
        assert.equal(res.status, 404);
    } finally {
        await testApp.close();
    }
});
