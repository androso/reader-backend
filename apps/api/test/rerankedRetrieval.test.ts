import assert from "node:assert/strict";
import test from "node:test";
import type {
    BookSearchChunk,
    HybridSearchDiagnostics,
    RankedSearchResult,
    RerankerProvider,
} from "@reader/providers";
import {
    deriveBaselineResults,
    expandRerankCandidates,
    buildBoundedRerankerDocuments,
    classifyRerankerFallback,
    describeRerankerError,
    retrieveRerankedEvidence,
    selectWithDeterministicMmr,
    wordTrigramJaccard,
} from "../src/services/RerankedRetrieval";

const result = (
    id: string,
    chunkIndex: number,
    score: number,
    content = id
): RankedSearchResult => ({
    id,
    chunkIndex,
    score,
    bestRank: chunkIndex + 1,
    content,
    metadata: { chapterIndex: 1, pageNumber: chunkIndex + 1 },
});

const diagnostics = (
    mode: HybridSearchDiagnostics["mode"]
): HybridSearchDiagnostics => ({
    mode,
    durationMs: 2,
    lexicalCandidates: [],
    vectorCandidates: [],
    selectedCandidates: [],
});

test("derives the exact hybrid and vector-only top-five baselines", () => {
    const candidates = Array.from({ length: 7 }, (_, index) =>
        result(
            `chunk-${index}`,
            index,
            index === 1 ? 0.029 : 0.04 - index / 1000
        )
    );
    assert.deepEqual(
        deriveBaselineResults(candidates, "hybrid", 0.03).map(
            (item) => item.id
        ),
        ["chunk-0", "chunk-2", "chunk-3", "chunk-4", "chunk-5"]
    );
    assert.deepEqual(
        deriveBaselineResults(candidates, "vector_only", 0.03).map(
            (item) => item.id
        ),
        candidates.slice(0, 5).map((item) => item.id)
    );
});

test("adds adjacent same-chapter or same-page neighbors and deduplicates them", () => {
    const firstStage = [result("chunk-2", 2, 0.04)];
    const chunks: BookSearchChunk[] = [1, 2, 3, 4].map((chunkIndex) => ({
        id: `chunk-${chunkIndex}`,
        collectionName: "book",
        chunkIndex,
        content: `content-${chunkIndex}`,
        metadata: {
            chapterIndex: chunkIndex === 1 ? 2 : 1,
            pageNumber: chunkIndex === 1 ? 3 : chunkIndex + 10,
        },
    }));
    const expanded = expandRerankCandidates(firstStage, chunks);
    assert.deepEqual(
        expanded.map((candidate) => [candidate.id, candidate.origin]),
        [
            ["chunk-2", "first_stage"],
            ["chunk-1", "neighbor"],
            ["chunk-3", "neighbor"],
        ]
    );
    assert.equal(expanded[1].neighborOf, "chunk-2");
});

test("budgets every candidate deterministically under 40k without dropping IDs", () => {
    const candidates = expandRerankCandidates(
        Array.from({ length: 30 }, (_, index) =>
            result(`chunk-${index}`, index, 0.04, "x".repeat(2_000))
        ),
        []
    );
    const bounded = buildBoundedRerankerDocuments(candidates);
    assert.deepEqual(
        bounded.map((candidate) => candidate.id),
        candidates.map((candidate) => candidate.id)
    );
    assert.ok(
        bounded.reduce(
            (total, candidate) => total + candidate.content.length,
            0
        ) <= 40_000
    );
    assert.ok(bounded.every((candidate) => candidate.content.length > 0));
});

test("classifies reranker fallbacks deterministically", () => {
    assert.equal(
        classifyRerankerFallback(new Error("request timed out")),
        "timeout"
    );
    assert.equal(
        classifyRerankerFallback(new Error("reranker refused")),
        "refusal"
    );
    assert.equal(
        classifyRerankerFallback(new Error("response returned invalid JSON")),
        "invalid_or_incomplete_ranking"
    );
    assert.equal(
        classifyRerankerFallback(new Error("wrong number of rankings")),
        "invalid_or_incomplete_ranking"
    );
    assert.equal(
        classifyRerankerFallback(new Error("network closed")),
        "provider_error"
    );
});

test("describes reranker failures without logging provider messages", () => {
    const validation = describeRerankerError(
        new Error(
            "Reranker response returned the wrong number of rankings: expected 30, received 12"
        )
    );
    assert.match(validation.errorDetail ?? "", /expected 30, received 12/);

    const providerError = Object.assign(
        new Error("provider echoed private excerpt text"),
        {
            status: 429,
            code: "rate_limit_exceeded",
            type: "rate_limit_error",
            request_id: "req-safe",
        }
    );
    const provider = describeRerankerError(providerError);
    assert.equal(provider.errorDetail, null);
    assert.equal(provider.providerStatus, 429);
    assert.equal(provider.providerCode, "rate_limit_exceeded");
    assert.equal(provider.providerType, "rate_limit_error");
    assert.equal(provider.providerRequestId, "req-safe");
    assert.equal(JSON.stringify(provider).includes("private excerpt"), false);
});

test("MMR uses trigram diversity with deterministic first-stage ties", () => {
    const duplicate = "alice saw the white rabbit run down the long hall";
    const candidates = expandRerankCandidates(
        [
            result("first", 0, 0.04, duplicate),
            result("duplicate", 1, 0.039, `${duplicate} quickly`),
            result(
                "diverse",
                2,
                0.038,
                "the queen ordered a public trial before the court"
            ),
        ],
        []
    );
    assert.ok(wordTrigramJaccard(duplicate, `${duplicate} quickly`) > 0.8);
    const selected = selectWithDeterministicMmr(
        candidates,
        new Map([
            ["first", 1],
            ["duplicate", 0.9],
            ["diverse", 0.8],
        ]),
        2
    );
    assert.deepEqual(
        selected.map((candidate) => candidate.id),
        ["first", "diverse"]
    );
});

test("provider failure returns the exact baseline with compact diagnostics", async () => {
    const broad = [
        result("one", 0, 0.04, "private excerpt one"),
        result("two", 1, 0.035, "private excerpt two"),
        result("weak", 2, 0.02, "private excerpt weak"),
    ];
    const failingReranker: RerankerProvider = {
        rerank: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw new Error("provider failed");
        },
    };
    const response = await retrieveRerankedEvidence({
        collectionName: "book",
        query: "query",
        searchService: {
            searchWithDiagnostics: async () => ({
                results: broad,
                diagnostics: diagnostics("hybrid"),
            }),
        },
        chunkReader: { getCollectionChunks: async () => [] },
        reranker: failingReranker,
    });
    assert.deepEqual(response.results, broad.slice(0, 2));
    assert.equal(response.diagnostics.reranker.status, "fallback");
    assert.equal(response.diagnostics.reranker.resolvedModel, null);
    assert.ok(response.diagnostics.reranker.durationMs >= 4);
    assert.equal(
        JSON.stringify(response.diagnostics).includes("private excerpt"),
        false
    );
});

test("fallback honors the configured hybrid threshold", async () => {
    const broad = [result("below-configured-threshold", 0, 0.04)];
    const response = await retrieveRerankedEvidence({
        collectionName: "book",
        query: "query",
        minHybridScore: 0.05,
        searchService: {
            searchWithDiagnostics: async () => ({
                results: broad,
                diagnostics: diagnostics("hybrid"),
            }),
        },
        chunkReader: { getCollectionChunks: async () => [] },
    });

    assert.deepEqual(response.results, []);
    assert.equal(response.diagnostics.reranker.status, "skipped");
    assert.equal(
        response.diagnostics.reranker.fallbackReason,
        "no_baseline_eligible_hybrid_seed"
    );
});

test("hybrid retrieval with no baseline seed skips the reranker", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    const response = await retrieveRerankedEvidence({
        collectionName: "book",
        query: "query",
        searchService: {
            searchWithDiagnostics: async () => ({
                results: [result("weak", 0, 0.02)],
                diagnostics: diagnostics("hybrid"),
            }),
        },
        chunkReader: { getCollectionChunks: async () => [] },
    });
    if (previousKey === undefined)
        Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    else process.env.OPENAI_API_KEY = previousKey;
    assert.deepEqual(response.results, []);
    assert.equal(response.diagnostics.reranker.status, "skipped");
    assert.equal(response.diagnostics.reranker.resolvedModel, null);
    assert.equal(response.diagnostics.reranker.durationMs, 0);
});

test("chunk expansion failure returns the exact baseline", async () => {
    const broad = [result("one", 0, 0.04), result("two", 1, 0.035)];
    const response = await retrieveRerankedEvidence({
        collectionName: "book",
        query: "query",
        searchService: {
            searchWithDiagnostics: async () => ({
                results: broad,
                diagnostics: diagnostics("hybrid"),
            }),
        },
        chunkReader: {
            getCollectionChunks: async () => {
                throw new Error("database unavailable");
            },
        },
    });
    assert.deepEqual(response.results, broad);
    assert.equal(
        response.diagnostics.reranker.fallbackReason,
        "provider_error"
    );
});
