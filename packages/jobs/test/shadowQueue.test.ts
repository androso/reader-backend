import assert from "node:assert/strict";
import test from "node:test";
import {
    createRagRerankShadowJobId,
    getRagRerankShadowSampleBucket,
    parseRagRerankShadowSampleRate,
    parseRagRerankShadowRateLimit,
    shouldSampleRagRerankShadow,
} from "../src";

test("shadow sampling defaults to disabled and validates decimal rates", () => {
    assert.equal(parseRagRerankShadowSampleRate(undefined), 0);
    assert.equal(parseRagRerankShadowSampleRate(""), 0);
    assert.equal(parseRagRerankShadowSampleRate("0.05"), 0.05);
    assert.equal(parseRagRerankShadowSampleRate("1"), 1);
    assert.throws(() => parseRagRerankShadowSampleRate("-0.1"), /0 to 1/);
    assert.throws(() => parseRagRerankShadowSampleRate("1.1"), /0 to 1/);
    assert.throws(() => parseRagRerankShadowSampleRate("invalid"), /0 to 1/);
});

test("shadow worker rate limit defaults to 30 and rejects invalid values", () => {
    assert.equal(parseRagRerankShadowRateLimit(undefined), 30);
    assert.equal(parseRagRerankShadowRateLimit("60"), 60);
    assert.throws(() => parseRagRerankShadowRateLimit("0"), /positive integer/);
    assert.throws(() => parseRagRerankShadowRateLimit("1.5"), /positive integer/);
});

test("shadow sampling is deterministic from the assistant message ID", () => {
    const messageId = "00000000-0000-4000-8000-000000000001";
    const bucket = getRagRerankShadowSampleBucket(messageId);
    assert.equal(bucket, getRagRerankShadowSampleBucket(messageId));
    assert.ok(bucket >= 0 && bucket < 1);
    assert.equal(shouldSampleRagRerankShadow(messageId, 0), false);
    assert.equal(shouldSampleRagRerankShadow(messageId, 1), true);
    assert.equal(
        shouldSampleRagRerankShadow(messageId, bucket + Number.EPSILON),
        true
    );
});

test("shadow jobs use a stable assistant-message job ID", () => {
    assert.equal(
        createRagRerankShadowJobId("assistant-1"),
        "rag-rerank-shadow-assistant-1"
    );
});
