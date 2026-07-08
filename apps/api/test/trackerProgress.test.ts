import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response, NextFunction } from "express";
import { db } from "../src/db";
import { Books, Progress } from "../src/db/schema";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret";

const trackerRoutes = require("../src/routes/Tracker.routes").default;

type RouteLayer = {
    route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{
            handle: (req: Request, res: Response, next: NextFunction) => void;
        }>;
    };
};

type ProgressMutationValues = {
    createdAt?: Date;
    updatedAt?: Date;
    [key: string]: unknown;
};

const asRequest = (request: unknown) => request as Request;

const getRouteHandlers = (method: string, path: string) => {
    const stack = (trackerRoutes as unknown as { stack: RouteLayer[] }).stack;
    const layer = stack.find(
        (item) => item.route?.path === path && item.route.methods[method]
    );

    assert.ok(layer?.route);
    return layer.route.stack.map((item) => item.handle);
};

const createResponse = () => {
    let statusCode = 200;
    let body: unknown;

    const res = {
        status(code: number) {
            statusCode = code;
            return this;
        },
        json(payload: unknown) {
            body = payload;
            return this;
        },
    } as Response;

    return {
        res,
        get statusCode() {
            return statusCode;
        },
        get body() {
            return body;
        },
    };
};

const installDbMock = ({
    bookRows = [],
    progressRows = [],
}: {
    bookRows?: unknown[];
    progressRows?: unknown[];
}) => {
    const dbMock = db as unknown as {
        select: unknown;
        update: unknown;
        insert: unknown;
    };
    const original = {
        select: dbMock.select,
        update: dbMock.update,
        insert: dbMock.insert,
    };
    const calls = {
        selectedTables: [] as unknown[],
        insertedValues: null as ProgressMutationValues | null,
        updatedValues: null as unknown,
    };

    dbMock.select = () => ({
        from(table: unknown) {
            calls.selectedTables.push(table);
            return {
                where: async () => {
                    if (table === Books) return bookRows;
                    if (table === Progress) return progressRows;
                    return [];
                },
            };
        },
    });
    dbMock.update = (table: unknown) => ({
        set(values: ProgressMutationValues) {
            calls.updatedValues = values;
            return {
                where: () => ({
                    returning: async () =>
                        table === Progress
                            ? [{ id: "updated-progress", ...values }]
                            : [],
                }),
            };
        },
    });
    dbMock.insert = (table: unknown) => ({
        values(values: ProgressMutationValues) {
            calls.insertedValues = values;
            return {
                returning: async () =>
                    table === Progress
                        ? [{ id: "inserted-progress", ...values }]
                        : [],
            };
        },
    });

    return {
        calls,
        restore() {
            dbMock.select = original.select;
            dbMock.update = original.update;
            dbMock.insert = original.insert;
        },
    };
};

test("does not expose the unauthenticated debug progress route", () => {
    const stack = (trackerRoutes as unknown as { stack: RouteLayer[] }).stack;
    const publicProgressRoute = stack.find(
        (item) => item.route?.path === "/progress" && item.route.methods.get
    );

    assert.equal(publicProgressRoute, undefined);
});

test("rejects unauthenticated progress access", async () => {
    const [authenticate] = getRouteHandlers("get", "/:rid/progress");
    const response = createResponse();
    let nextCalled = false;

    await authenticate(
        asRequest({ headers: {}, params: { rid: "book-1" } }),
        response.res,
        (() => {
            nextCalled = true;
        }) as NextFunction
    );

    assert.equal(nextCalled, false);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { message: "No token provided" });
});

test("returns 404 for a non-owner book id without reading progress", async () => {
    const [, handler] = getRouteHandlers("get", "/:rid/progress");
    const mock = installDbMock({ bookRows: [] });
    const response = createResponse();

    try {
        await handler(
            asRequest({
                user: { id: "owner-1" },
                params: { rid: "someone-elses-book" },
            }),
            response.res,
            (() => undefined) as NextFunction
        );
    } finally {
        mock.restore();
    }

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { message: "Book not found" });
    assert.deepEqual(mock.calls.selectedTables, [Books]);
});

test("returns 404 for a missing owned book id", async () => {
    const [, handler] = getRouteHandlers("get", "/:rid/progress");
    const mock = installDbMock({ bookRows: [] });
    const response = createResponse();

    try {
        await handler(
            asRequest({
                user: { id: "owner-1" },
                params: { rid: "missing-book" },
            }),
            response.res,
            (() => undefined) as NextFunction
        );
    } finally {
        mock.restore();
    }

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { message: "Book not found" });
});

test("returns owner progress for an owned book id", async () => {
    const [, handler] = getRouteHandlers("get", "/:rid/progress");
    const mock = installDbMock({
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
    const response = createResponse();

    try {
        await handler(
            asRequest({
                user: { id: "owner-1" },
                params: { rid: "book-1" },
            }),
            response.res,
            (() => undefined) as NextFunction
        );
    } finally {
        mock.restore();
    }

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
        progressPosition: "c01-block-1",
        progressChapter: "c01",
    });
});

test("writes owner progress for an owned book id", async () => {
    const [, handler] = getRouteHandlers("post", "/:rid/progress");
    const mock = installDbMock({
        bookRows: [{ id: "book-1", userId: "owner-1" }],
        progressRows: [],
    });
    const response = createResponse();

    try {
        await handler(
            asRequest({
                user: { id: "owner-1" },
                params: { rid: "book-1" },
                body: {
                    progress_block: "c01-block-2",
                    progress_chapter: "c01",
                },
            }),
            response.res,
            (() => undefined) as NextFunction
        );
    } finally {
        mock.restore();
    }

    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.body, {
        message: "Progress saved",
        data: {
            id: "inserted-progress",
            userId: "owner-1",
            bookId: "book-1",
            progressPosition: "c01-block-2",
            progressChapter: "c01",
            createdAt: mock.calls.insertedValues!.createdAt,
            updatedAt: mock.calls.insertedValues!.updatedAt,
        },
    });
});
