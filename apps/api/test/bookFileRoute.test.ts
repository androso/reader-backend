import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { handleGetBookFile } from "../src/routes/Book.routes";

type TestResponse = {
    statusCode: number;
    body?: unknown;
    contentType?: string;
    sent?: unknown;
    status(code: number): TestResponse;
    json(payload: unknown): TestResponse;
    type(contentType: string): TestResponse;
    send(payload: unknown): TestResponse;
};

const createResponse = (): TestResponse => {
    const res: TestResponse = {
        statusCode: 200,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(payload: unknown) {
            this.body = payload;
            return this;
        },
        type(contentType: string) {
            this.contentType = contentType;
            return this;
        },
        send(payload: unknown) {
            this.sent = payload;
            return this;
        },
    };

    return res;
};

const createRequest = (bookId: string, userId: string) =>
    ({
        params: { id: bookId },
        user: { id: userId },
    }) as unknown as Request;

test("fetches an owned book file by the book row's file key", async () => {
    const calls: string[] = [];
    const res = createResponse();
    const fileBuffer = Buffer.from("owned book");

    await handleGetBookFile(
        createRequest("book-1", "user-1"),
        res as unknown as Response,
        {
            async findBookById(bookId) {
                assert.equal(bookId, "book-1");
                return {
                    id: "book-1",
                    userId: "user-1",
                    fileKey: "epub-storage-key",
                    fileType: "epub",
                };
            },
            async getFile(fileKey) {
                calls.push(fileKey);
                return fileBuffer;
            },
        }
    );

    assert.deepEqual(calls, ["epub-storage-key"]);
    assert.equal(res.statusCode, 200);
    assert.equal(res.contentType, "application/epub+zip");
    assert.equal(res.sent, fileBuffer);
});

test("rejects a non-owner before reading storage", async () => {
    const calls: string[] = [];
    const res = createResponse();

    await handleGetBookFile(
        createRequest("book-1", "user-2"),
        res as unknown as Response,
        {
            async findBookById() {
                return {
                    id: "book-1",
                    userId: "user-1",
                    fileKey: "epub-storage-key",
                    fileType: "epub",
                };
            },
            async getFile(fileKey) {
                calls.push(fileKey);
                return Buffer.from("should not be read");
            },
        }
    );

    assert.deepEqual(calls, []);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "Not authorized" });
});

test("returns not found for a missing book before reading storage", async () => {
    const calls: string[] = [];
    const res = createResponse();

    await handleGetBookFile(
        createRequest("missing-book", "user-1"),
        res as unknown as Response,
        {
            async findBookById(bookId) {
                assert.equal(bookId, "missing-book");
                return undefined;
            },
            async getFile(fileKey) {
                calls.push(fileKey);
                return Buffer.from("should not be read");
            },
        }
    );

    assert.deepEqual(calls, []);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: "Book was not found" });
});
