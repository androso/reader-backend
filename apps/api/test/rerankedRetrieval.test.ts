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
    maxWordTrigramSimilarity,
    retrieveRerankedEvidence,
    selectDiversityGuardedMmr,
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
        classifyRerankerFallback(
            new Error("Reranker response incomplete: finish reason length")
        ),
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

test("MMR enforces a deterministic maximum similarity ceiling", () => {
    const shared = "alice followed the white rabbit through the long hall";
    const candidates = expandRerankCandidates(
        [
            result("first", 0, 0.04, shared),
            result("duplicate", 1, 0.039, `${shared} quickly`),
            result(
                "diverse",
                2,
                0.038,
                "the queen convened a trial before the assembled court"
            ),
        ],
        []
    );
    const scores = new Map([
        ["first", 1],
        ["duplicate", 0.99],
        ["diverse", 0.1],
    ]);
    const unconstrained = selectWithDeterministicMmr(candidates, scores, 2);
    const guarded = selectWithDeterministicMmr(candidates, scores, 2, 0.1);

    assert.deepEqual(
        unconstrained.map((candidate) => candidate.id),
        ["first", "duplicate"]
    );
    assert.deepEqual(
        guarded.map((candidate) => candidate.id),
        ["first", "diverse"]
    );
    assert.ok(maxWordTrigramSimilarity(guarded) <= 0.1);
});

test("diversity guard backtracks to a complete set under the ceiling", () => {
    const candidates = expandRerankCandidates(
        [
            result(
                "highest",
                0,
                0.04,
                "alice followed the white rabbit through the long hall"
            ),
            result(
                "stable",
                1,
                0.039,
                "the queen convened a trial before the assembled court"
            ),
            result(
                "conflict-1",
                2,
                0.038,
                "alice followed the white rabbit before sunset"
            ),
            result(
                "conflict-2",
                3,
                0.037,
                "through the long hall today everyone cheered"
            ),
        ],
        []
    );
    const guarded = selectDiversityGuardedMmr(
        candidates,
        new Map([
            ["highest", 1],
            ["stable", 0.8],
            ["conflict-1", 0.7],
            ["conflict-2", 0.6],
        ]),
        0,
        3
    );

    assert.deepEqual(
        guarded.map((candidate) => candidate.id),
        ["stable", "conflict-1", "conflict-2"]
    );
    assert.equal(maxWordTrigramSimilarity(guarded), 0);
});

test("successful reranking cannot exceed exact baseline diversity", async () => {
    const baselineContents = [
        "alpha one two three four",
        "bravo five six seven eight",
        "charlie nine ten eleven twelve",
        "delta thirteen fourteen fifteen sixteen",
        "echo seventeen eighteen nineteen twenty",
    ];
    const broad = [
        ...baselineContents.map((content, index) =>
            result(`baseline-${index}`, index, 0.05 - index / 1000, content)
        ),
        result("duplicate", 5, 0.031, `${baselineContents[0]} repeated words`),
    ];
    const reranker: RerankerProvider = {
        rerank: async ({ documents }) => ({
            rankings: documents.map((document, index) => ({
                id: document.id,
                score:
                    document.id === "baseline-0"
                        ? 1
                        : document.id === "duplicate"
                          ? 0.99
                          : 0.1 - index / 1000,
                rank: index + 1,
            })),
            requestedModel: "gpt-5.4-mini-2026-03-17",
            resolvedModel: "gpt-5.4-mini-2026-03-17",
            usage: {
                prompt_tokens: 10,
                completion_tokens: 10,
                total_tokens: 20,
            },
            durationMs: 5,
        }),
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
        reranker,
    });

    assert.equal(response.diagnostics.reranker.status, "success");
    assert.ok(
        maxWordTrigramSimilarity(response.results) <=
            maxWordTrigramSimilarity(broad.slice(0, 5))
    );
    assert.equal(
        response.results.some((candidate) => candidate.id === "duplicate"),
        false
    );
    assert.ok(
        response.diagnostics.finalCandidates.every((candidate) =>
            candidate.selectionReason.startsWith("diversity_guard")
        )
    );
});

test("short hybrid baselines preserve the reranked result count", async () => {
    const shared = "alice followed the white rabbit through the long hall";
    const broad = [
        result("baseline-0", 0, 0.05, shared),
        result(
            "baseline-1",
            1,
            0.04,
            "the queen convened a trial before the assembled court"
        ),
        result("weak-duplicate", 2, 0.029, `${shared} quickly`),
        result(
            "weak-1",
            3,
            0.028,
            "the caterpillar offered advice from atop a mushroom"
        ),
        result(
            "weak-2",
            4,
            0.027,
            "the dormouse told a story during the tea party"
        ),
    ];
    const reranker: RerankerProvider = {
        rerank: async ({ documents }) => ({
            rankings: documents.map((document, index) => ({
                id: document.id,
                score: 1 - index / 100,
                rank: index + 1,
            })),
            requestedModel: "gpt-5.4-mini-2026-03-17",
            resolvedModel: "gpt-5.4-mini-2026-03-17",
            usage: {
                prompt_tokens: 10,
                completion_tokens: 10,
                total_tokens: 20,
            },
            durationMs: 5,
        }),
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
        reranker,
    });

    assert.equal(deriveBaselineResults(broad, "hybrid", 0.03).length, 2);
    assert.equal(response.results.length, 5);
    assert.equal(response.diagnostics.reranker.status, "success");
    assert.ok(
        response.diagnostics.finalCandidates.every(
            (candidate) =>
                candidate.selectionReason.startsWith("diversity_guard")
        )
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

test("strict infrastructure mode surfaces chunk expansion failures", async () => {
    const broad = [result("one", 0, 0.04), result("two", 1, 0.035)];

    await assert.rejects(
        retrieveRerankedEvidence({
            collectionName: "book",
            query: "query",
            strictInfrastructureErrors: true,
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
        }),
        /database unavailable/
    );
});
