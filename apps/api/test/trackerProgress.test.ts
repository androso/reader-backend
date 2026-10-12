import assert from "node:assert/strict";
import test from "node:test";
import type { ReadingProgress } from "@reader/domain";
import type { User } from "../src/types";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";
process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:1/test";
process.env.REDIS_URL = "";
process.env.LANGFUSE_SAMPLE_RATE = "0";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const { TrackerController } =
    require("../src/tracker/tracker.controller") as typeof import("../src/tracker/tracker.controller");
const { GET_READING_PROGRESS, SAVE_READING_PROGRESS } =
    require("../src/tracker/progress.tokens") as typeof import("../src/tracker/progress.tokens");
const { DRIZZLE } =
    require("../src/database/database.module") as typeof import("../src/database/database.module");
const { GetReadingProgress, SaveReadingProgress } =
    require("@reader/application") as typeof import("@reader/application");
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

const readingProgress: ReadingProgress = {
    userId: "owner-1",
    bookId: "book-1",
    progressPosition: "p1",
    progressChapter: "c1",
    lastReadAt: new Date("2024-01-01T00:00:00Z"),
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
};

const createTrackerTestApp = (
    options: {
        get?: {
            execute(input: {
                userId: string;
                bookId: string;
            }): Promise<unknown>;
        };
        save?: {
            execute(input: {
                userId: string;
                bookId: string;
                position: unknown;
                chapter?: unknown;
            }): Promise<unknown>;
        };
        user?: User;
    } = {}
) =>
    createTestApp({
        controllers: [TrackerController],
        providers: [
            { provide: DRIZZLE, useValue: {} },
            {
                provide: GET_READING_PROGRESS,
                useValue: options.get ?? {
                    execute: async () => null,
                },
            },
            {
                provide: SAVE_READING_PROGRESS,
                useValue: options.save ?? {
                    execute: async () => readingProgress,
                },
            },
        ],
        ...(options.user === undefined ? {} : { user: options.user }),
    });

const postProgress = (
    baseUrl: string,
    options: { headers?: Record<string, string>; body?: string } = {}
) =>
    fetch(`${baseUrl}/api/book-1/progress`, {
        method: "POST",
        headers: options.headers ?? {},
        body: options.body,
    });

const jsonHeaders = { "Content-Type": "application/json" };

test("rejects unauthenticated GET and POST progress access", async () => {
    const testApp = await createTrackerTestApp();
    try {
        const get = await fetch(`${testApp.baseUrl}/api/book-1/progress`);
        assert.equal(get.status, 401);
        assert.deepEqual(await get.json(), { message: "No token provided" });

        const post = await postProgress(testApp.baseUrl, {
            headers: jsonHeaders,
            body: JSON.stringify({ progress_block: "p1" }),
        });
        assert.equal(post.status, 401);
        assert.deepEqual(await post.json(), { message: "No token provided" });
    } finally {
        await testApp.close();
    }
});

test("GET returns the initial position when there is no progress row", async () => {
    let received: unknown;
    const testApp = await createTrackerTestApp({
        user: owner,
        get: {
            execute: async (input) => {
                received = input;
                return null;
            },
        },
    });
    try {
        const response = await fetch(`${testApp.baseUrl}/api/book-1/progress`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { progressPosition: null });
        assert.deepEqual(received, { userId: "owner-1", bookId: "book-1" });
    } finally {
        await testApp.close();
    }
});

test("GET returns position and nullable chapter", async () => {
    const testApp = await createTrackerTestApp({
        user: owner,
        get: {
            execute: async () => ({
                ...readingProgress,
                progressChapter: null,
            }),
        },
    });
    try {
        const response = await fetch(`${testApp.baseUrl}/api/book-1/progress`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            progressPosition: "p1",
            progressChapter: null,
        });
    } finally {
        await testApp.close();
    }
});

test("GET maps a missing or foreign book to the existing 404 body", async () => {
    const get = new GetReadingProgress({
        books: { findOwned: async () => null },
        progress: { find: async () => readingProgress },
    });
    const testApp = await createTrackerTestApp({ user: owner, get });
    try {
        const response = await fetch(
            `${testApp.baseUrl}/api/foreign-book/progress`
        );
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { message: "Book not found" });
    } finally {
        await testApp.close();
    }
});

test("GET preserves unexpected-error logging and response", async () => {
    const failure = new Error("database unavailable");
    const errors: unknown[][] = [];
    const previous = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    const testApp = await createTrackerTestApp({
        user: owner,
        get: {
            execute: async () => {
                throw failure;
            },
        },
    });
    try {
        const response = await fetch(`${testApp.baseUrl}/api/book-1/progress`);
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), {
            message: "Internal server error",
        });
        assert.deepEqual(errors, [["Error fetching progress:", failure]]);
    } finally {
        console.error = previous;
        await testApp.close();
    }
});

test("POST returns saved row with 201 for JSON", async () => {
    let received: unknown;
    const testApp = await createTrackerTestApp({
        user: owner,
        save: {
            execute: async (input) => {
                received = input;
                return readingProgress;
            },
        },
    });
    try {
        const response = await postProgress(testApp.baseUrl, {
            headers: jsonHeaders,
            body: JSON.stringify({
                progress_block: "p1",
                progress_chapter: "c1",
            }),
        });
        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), {
            message: "Progress saved",
            data: {
                userId: "owner-1",
                bookId: "book-1",
                progressPosition: "p1",
                progressChapter: "c1",
                lastReadAt: "2024-01-01T00:00:00.000Z",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
            },
        });
        assert.deepEqual(received, {
            userId: "owner-1",
            bookId: "book-1",
            position: "p1",
            chapter: "c1",
        });
    } finally {
        await testApp.close();
    }
});

test("POST preserves urlencoded empty chapter", async () => {
    let received: unknown;
    const testApp = await createTrackerTestApp({
        user: owner,
        save: {
            execute: async (input) => {
                received = input;
                return { ...readingProgress, progressChapter: "" };
            },
        },
    });
    try {
        const response = await postProgress(testApp.baseUrl, {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: "progress_block=p1&progress_chapter=",
        });
        assert.equal(response.status, 201);
        assert.equal((await response.json()).data.progressChapter, "");
        assert.deepEqual(received, {
            userId: "owner-1",
            bookId: "book-1",
            position: "p1",
            chapter: "",
        });
    } finally {
        await testApp.close();
    }
});

test("POST maps chapter omission and explicit null distinctly", async () => {
    const requests: unknown[] = [];
    const testApp = await createTrackerTestApp({
        user: owner,
        save: {
            execute: async (input) => {
                requests.push(input);
                return readingProgress;
            },
        },
    });
    try {
        const omitted = await postProgress(testApp.baseUrl, {
            headers: jsonHeaders,
            body: JSON.stringify({ progress_block: "p1" }),
        });
        const cleared = await postProgress(testApp.baseUrl, {
            headers: jsonHeaders,
            body: JSON.stringify({
                progress_block: "p2",
                progress_chapter: null,
            }),
        });
        assert.equal(omitted.status, 201);
        assert.equal(cleared.status, 201);
        assert.deepEqual(requests, [
            {
                userId: "owner-1",
                bookId: "book-1",
                position: "p1",
            },
            {
                userId: "owner-1",
                bookId: "book-1",
                position: "p2",
                chapter: null,
            },
        ]);
    } finally {
        await testApp.close();
    }
});

test("POST rejects invalid positions and chapters before repository access", async () => {
    let saves = 0;
    const save = new SaveReadingProgress({
        repository: {
            saveForLiveOwnedBook: async () => {
                saves += 1;
                return readingProgress;
            },
        },
        clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    });
    const testApp = await createTrackerTestApp({ user: owner, save });
    try {
        const invalidRequests = [
            {
                body: JSON.stringify({ progress_block: 123 }),
                message: "Progress Block must be a non-empty string",
            },
            {
                body: JSON.stringify({ progress_block: " \t " }),
                message: "Progress Block must be a non-empty string",
            },
            {
                body: JSON.stringify({ progress_block: null }),
                message: "Progress Block is required",
            },
            {
                body: JSON.stringify({ progress_block: "" }),
                message: "Progress Block is required",
            },
            {
                body: JSON.stringify({
                    progress_block: "p1",
                    progress_chapter: 12,
                }),
                message: "Progress Chapter must be a string or null",
            },
        ];

        for (const request of invalidRequests) {
            const response = await postProgress(testApp.baseUrl, {
                headers: jsonHeaders,
                body: request.body,
            });
            assert.equal(response.status, 400);
            assert.deepEqual(await response.json(), {
                message: request.message,
            });
        }
        assert.equal(saves, 0);
    } finally {
        await testApp.close();
    }
});

test("POST maps deleting-book not found and preserves unexpected-error logging", async () => {
    const missing = new SaveReadingProgress({
        repository: { saveForLiveOwnedBook: async () => null },
        clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    });
    const notFoundApp = await createTrackerTestApp({
        user: owner,
        save: missing,
    });
    try {
        const response = await postProgress(notFoundApp.baseUrl, {
            headers: jsonHeaders,
            body: JSON.stringify({ progress_block: "p1" }),
        });
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { message: "Book not found" });
    } finally {
        await notFoundApp.close();
    }

    const failure = new Error("database unavailable");
    const errors: unknown[][] = [];
    const previous = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    const errorApp = await createTrackerTestApp({
        user: owner,
        save: {
            execute: async () => {
                throw failure;
            },
        },
    });
    try {
        const response = await postProgress(errorApp.baseUrl, {
            headers: jsonHeaders,
            body: JSON.stringify({ progress_block: "p1" }),
        });
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), {
            message: "Progress wasn't saved",
        });
        assert.deepEqual(errors, [["Progress can't be tracked", failure]]);
    } finally {
        console.error = previous;
        await errorApp.close();
    }
});
