import assert from "node:assert/strict";
import test from "node:test";
import {
    getSubmittedUserMessage,
    mapFinishReason,
    normalizeChatMessage,
    normalizeEpubHighlight,
    selectHistoryWindow,
} from "../src/chat";

test("normalizes submitted chat messages at the 8,000-character boundary", () => {
    assert.equal(normalizeChatMessage(` ${"x".repeat(7_999)} `)?.length, 7_999);
    assert.equal(normalizeChatMessage("x".repeat(8_000))?.length, 8_000);
    assert.equal(normalizeChatMessage("x".repeat(8_001)), null);
    assert.equal(getSubmittedUserMessage({ message: "  hello  " }), "hello");
});

test("selects at most the last 30 messages", () => {
    const messages = Array.from({ length: 31 }, (_, index) => ({
        role: "user" as const,
        content: String(index),
    }));

    const selected = selectHistoryWindow(messages);
    assert.equal(selected.length, 30);
    assert.equal(selected[0]?.content, "1");
    assert.equal(selected[selected.length - 1]?.content, "30");
});

test("includes a history window exactly at the 60,000-character budget", () => {
    const messages = Array.from({ length: 30 }, () => ({
        role: "assistant" as const,
        content: "x".repeat(2_000),
    }));

    assert.equal(selectHistoryWindow(messages).length, 30);
    assert.equal(
        selectHistoryWindow([
            ...messages,
            { role: "user" as const, content: "y" },
        ]).length,
        30
    );
    const overBudget = selectHistoryWindow([
        ...Array.from({ length: 29 }, () => ({
            role: "assistant" as const,
            content: "x".repeat(2_000),
        })),
        { role: "user" as const, content: "y".repeat(2_001) },
    ]);
    assert.equal(overBudget.length, 29);
    assert.equal(
        overBudget.reduce(
            (total, message) => total + message.content.length,
            0
        ),
        58_001
    );
});

test("normalizes EPUB highlights at the 4,000-character boundary", () => {
    assert.equal(
        normalizeEpubHighlight({
            sourceType: "epub",
            text: "x".repeat(4_000),
        })?.text.length,
        4_000
    );
    assert.equal(
        normalizeEpubHighlight({
            sourceType: "epub",
            text: "x".repeat(4_001),
        })?.text.length,
        4_000
    );
});

test("maps every current finish reason to the persisted completion status", () => {
    for (const [reason, status] of [
        ["stop", "complete"],
        ["length", "truncated"],
        ["content_filter", "failed"],
        ["tool_calls", "failed"],
        [null, "failed"],
        ["unknown", "failed"],
    ] as const) {
        assert.equal(mapFinishReason(reason), status);
    }
});
