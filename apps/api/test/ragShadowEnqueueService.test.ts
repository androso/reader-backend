import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { maybeEnqueueRagRerankShadow } from "../src/services/RagShadowEnqueueService";

const input = {
    assistantMessageId: "assistant-1",
    userMessageId: "user-message-1",
    conversationId: "conversation-1",
    bookId: "book-1",
    userId: "user-1",
    hasHighlightContext: false,
};

test("shadow enqueue sends only durable identifiers", async () => {
    const enqueued: unknown[] = [];
    const status = await maybeEnqueueRagRerankShadow(input, {
        sampleRate: 1,
        enqueue: async (payload) => {
            enqueued.push(payload);
        },
    });

    assert.equal(status, "enqueued");
    assert.deepEqual(enqueued, [
        {
            assistantMessageId: "assistant-1",
            userMessageId: "user-message-1",
            conversationId: "conversation-1",
            bookId: "book-1",
            userId: "user-1",
        },
    ]);
});

test("shadow enqueue excludes highlighted requests", async () => {
    let called = false;
    const status = await maybeEnqueueRagRerankShadow(
        { ...input, hasHighlightContext: true },
        {
            sampleRate: 1,
            enqueue: async () => {
                called = true;
            },
        }
    );
    assert.equal(status, "excluded_highlight");
    assert.equal(called, false);
});

test("shadow enqueue is disabled at zero sample rate", async () => {
    let called = false;
    const status = await maybeEnqueueRagRerankShadow(input, {
        sampleRate: 0,
        enqueue: async () => {
            called = true;
        },
    });
    assert.equal(status, "not_sampled");
    assert.equal(called, false);
});

test("shadow queue failures never reject chat completion", async () => {
    const status = await maybeEnqueueRagRerankShadow(input, {
        sampleRate: 1,
        enqueue: async () => {
            throw new Error("redis unavailable");
        },
    });
    assert.equal(status, "enqueue_failed");
});

test("invalid shadow configuration never rejects chat completion", async () => {
    const previous = process.env.RAG_RERANK_SHADOW_SAMPLE_RATE;
    process.env.RAG_RERANK_SHADOW_SAMPLE_RATE = "invalid";
    try {
        const status = await maybeEnqueueRagRerankShadow(input, {
            enqueue: async () => {
                throw new Error("must not enqueue");
            },
        });
        assert.equal(status, "invalid_configuration");
    } finally {
        if (previous === undefined) {
            delete process.env.RAG_RERANK_SHADOW_SAMPLE_RATE;
        } else {
            process.env.RAG_RERANK_SHADOW_SAMPLE_RATE = previous;
        }
    }
});

test("chat completes the event sink before awaiting shadow queue I/O", () => {
    const route = readFileSync(
        join(
            resolve(__dirname, "../../.."),
            "packages/application/src/chat/RunBookChat.ts"
        ),
        "utf8"
    );
    const completion = route.lastIndexOf("await input.sink.complete()");
    const shadowSchedule = route.indexOf(
        "await this.deps.shadow.maybeSchedule"
    );

    assert.ok(completion >= 0);
    assert.ok(
        shadowSchedule > completion,
        "shadow work starts after the sink is complete"
    );
});
