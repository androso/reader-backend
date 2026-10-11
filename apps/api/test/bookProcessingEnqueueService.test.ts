import assert from "node:assert/strict";
import test from "node:test";
import type { BookProcessingEnqueueDependencies } from "../src/services/BookProcessingEnqueueService";
import {
    BookProcessingQueueUnavailableError,
    handleBookProcessingEnqueue,
} from "../src/services/BookProcessingEnqueueService";

const payload = {
    bookId: "book-1",
    userId: "user-1",
    fileKey: "epub-key",
    fileType: "epub" as const,
};

const createDependencies = (
    overrides: Partial<BookProcessingEnqueueDependencies> = {}
) => {
    const calls = {
        enqueued: [] as unknown[],
        failed: [] as Array<{ bookId: string; error: string }>,
    };

    const dependencies: BookProcessingEnqueueDependencies = {
        enqueue: async (data) => {
            calls.enqueued.push(data);
        },
        repository: {
            markQueueFailed: async (bookId, _userId, error) => {
                calls.failed.push({ bookId, error });
                return true;
            },
        },
        ...overrides,
    };

    return { dependencies, calls };
};

test("successful enqueue leaves processing state untouched", async () => {
    const { dependencies, calls } = createDependencies();

    await handleBookProcessingEnqueue(payload, dependencies);

    assert.deepEqual(calls.enqueued, [payload]);
    assert.deepEqual(calls.failed, []);
});

test("enqueue failure marks book failed and retains the original", async () => {
    const { dependencies, calls } = createDependencies({
        enqueue: async () => {
            throw new Error("connect ECONNREFUSED");
        },
    });

    await assert.rejects(
        handleBookProcessingEnqueue(payload, dependencies),
        BookProcessingQueueUnavailableError
    );

    assert.deepEqual(calls.failed, [
        { bookId: "book-1", error: "connect ECONNREFUSED" },
    ]);
});
