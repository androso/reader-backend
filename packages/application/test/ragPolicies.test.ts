import assert from "node:assert/strict";
import test from "node:test";
import type { RagChunk, RagRankedResult } from "@reader/domain";
import {
    deriveHybridSearchResponse,
    fuseHybridResults,
    hydrateVectorResults,
} from "../src/rag/policies/hybridSearch";
import {
    buildBoundedRerankerDocuments,
    classifyRerankerFallback,
    deriveBaselineResults,
    expandRerankCandidates,
    selectWithDeterministicMmr,
} from "../src/rag/policies/reranking";

const result = (
    id: string,
    chunkIndex: number,
    score: number,
    content = id
): RagRankedResult => ({
    id,
    content,
    chunkIndex,
    score,
    bestRank: chunkIndex + 1,
    metadata: { chapterIndex: 1, pageNumber: chunkIndex + 1 },
});

test("hybrid threshold is inclusive while vector-only results bypass it", () => {
    const broad = [
        result("at", 0, 0.03),
        result("below", 1, 0.029999),
        result("above", 2, 0.04),
    ];
    assert.deepEqual(
        deriveBaselineResults(broad, "hybrid", 0.03).map(({ id }) => id),
        ["at", "above"]
    );
    assert.deepEqual(
        deriveBaselineResults(broad, "vector_only", 0.03).map(({ id }) => id),
        ["at", "below", "above"]
    );
    const vectorOnly = { id: "v", content: "vector", rank: 1 };
    assert.equal(
        deriveHybridSearchResponse([], [vectorOnly], [vectorOnly], {
            finalLimit: 5,
            minScore: 1,
            durationMs: 0,
        }).results[0]?.id,
        "v"
    );
});

test("reciprocal-rank fusion uses deterministic score, rank, and chunk ties", () => {
    const lexical = [
        {
            id: "tie-a",
            content: "same",
            chunkIndex: 0,
            rank: 1,
        },
        {
            id: "tie-b",
            content: "same",
            chunkIndex: 1,
            rank: 2,
        },
    ];
    const vector = [
        { id: "tie-b", content: "same", rank: 1 },
        { id: "tie-a", content: "same", rank: 2 },
    ];
    const fused = fuseHybridResults(lexical, vector, 5);
    assert.deepEqual(
        fused.map(({ id }) => id),
        ["tie-a", "tie-b"]
    );
    assert.equal(fused[0]?.score, fused[1]?.score);
});

test("vector hydration uses chunk content, index and metadata", () => {
    const chunks: RagChunk[] = [
        {
            id: "book_7",
            collectionName: "book",
            chunkIndex: 7,
            content: "hydrated content",
            metadata: { chapterIndex: 2 },
        },
    ];
    assert.deepEqual(
        hydrateVectorResults([{ id: "book_7", content: "", rank: 1 }], chunks),
        [
            {
                id: "book_7",
                content: "hydrated content",
                rank: 1,
                chunkIndex: 7,
                metadata: { chapterIndex: 2 },
            },
        ]
    );
});

test("neighbor expansion checks both edges and bounds reranker documents", () => {
    const chunks: RagChunk[] = [0, 1, 2].map((chunkIndex) => ({
        id: `c${chunkIndex}`,
        collectionName: "book",
        chunkIndex,
        content: `chunk ${chunkIndex}`,
        metadata: { chapterIndex: 1 },
    }));
    assert.deepEqual(
        expandRerankCandidates([result("c0", 0, 0.04)], chunks).map(
            ({ id }) => id
        ),
        ["c0", "c1"]
    );
    assert.deepEqual(
        expandRerankCandidates([result("c2", 2, 0.04)], chunks).map(
            ({ id }) => id
        ),
        ["c2", "c1"]
    );

    const bounded = buildBoundedRerankerDocuments(
        expandRerankCandidates(
            Array.from({ length: 30 }, (_, index) =>
                result(`long-${index}`, index, 0.04, "x".repeat(2_000))
            ),
            []
        )
    );
    assert.equal(bounded.length, 30);
    assert.ok(
        bounded.reduce(
            (total, document) => total + document.content.length,
            0
        ) <= 40_000
    );
});

test("malformed reranker failures classify as invalid and provider timeouts remain timeouts", () => {
    assert.equal(
        classifyRerankerFallback({
            category: "invalid_or_incomplete_ranking",
            message: "unknown alias",
        }),
        "invalid_or_incomplete_ranking"
    );
    assert.equal(
        classifyRerankerFallback({
            category: "timeout",
            message: "provider-local timeout",
        }),
        "timeout"
    );
    assert.equal(
        classifyRerankerFallback({
            category: "provider_error",
            message: "provider failed",
        }),
        "provider_error"
    );
    assert.equal(
        classifyRerankerFallback(new Error("request timed out")),
        "timeout"
    );
});

test("MMR preserves deterministic first-stage ties", () => {
    const candidates = expandRerankCandidates(
        [
            result("first", 0, 0.04, "alpha bravo charlie"),
            result("second", 1, 0.04),
        ],
        []
    );
    const selected = selectWithDeterministicMmr(
        candidates,
        new Map([
            ["first", 0.5],
            ["second", 0.5],
        ]),
        2
    );
    assert.deepEqual(
        selected.map(({ id }) => id),
        ["first", "second"]
    );
});
