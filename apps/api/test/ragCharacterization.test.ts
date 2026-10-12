import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { HybridBookSearchService } from "../src/services/HybridBookSearchService";
import {
    estimateModelCost,
    normalizeModelUsage,
    generateBookAnswer,
} from "../src/rag";
import { buildChatCompletionRequest } from "../src/services/OpenAIServices";
import { compareShadowSourceRanks } from "../src/rag-shadow";
import {
    buildRetrievalQuery,
    buildBookContextSystemPrompt,
} from "../src/services/HighlightContext";
import {
    buildBoundedRerankerDocuments,
    classifyRerankerFallback,
    deriveBaselineResults,
    expandRerankCandidates,
    retrieveRerankedEvidence,
    selectDiversityGuardedMmr,
    selectWithDeterministicMmr,
} from "../src/services/RerankedRetrieval";
import type { BookSearchChunk, RankedSearchResult } from "@reader/providers";
import { buildRerankerRequest, OpenAIChatReranker } from "@reader/providers";

const goldenPath = join(
    __dirname,
    "../../../apps/api/test/fixtures/rag-characterization.json"
);
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Record<
    string,
    unknown
>;

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

const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
            key,
            key === "durationMs" ||
            key === "retrievalDurationMs" ||
            key === "completedAt"
                ? "<time>"
                : key === "traceId" || key === "langfuseTraceId"
                  ? "<trace-id>"
                  : normalize(item),
        ])
    );
};

test("current exported RAG functions reproduce the deterministic golden scenarios", async () => {
    const originalNow = Date.now;
    const originalPipeline = process.env.RAG_PIPELINE_VERSION;
    Date.now = () => 1_000;
    process.env.RAG_PIPELINE_VERSION = "baseline-rag-v1";
    try {
        const emptySearch = new HybridBookSearchService(
            { getCollectionChunks: async () => [] },
            { searchDocuments: async () => [] }
        );
        const empty = await emptySearch.searchWithDiagnostics("empty", "q");
        const vectorOnlySearch = new HybridBookSearchService(
            { getCollectionChunks: async () => [] },
            {
                searchDocuments: async () => [
                    { id: "v0", content: "vector", rank: 1, distance: 0.2 },
                ],
            }
        );
        const vectorOnly = await vectorOnlySearch.searchWithDiagnostics(
            "vector",
            "q"
        );
        const tiedSearch = new HybridBookSearchService(
            {
                getCollectionChunks: async () =>
                    (["tie-a", "tie-b"] as const).map((id, chunkIndex) => ({
                        id,
                        collectionName: "ties",
                        chunkIndex,
                        content: "same searchable phrase",
                    })),
            },
            {
                searchDocuments: async () => [
                    {
                        id: "tie-b",
                        content: "same searchable phrase",
                        rank: 1,
                        distance: 0.1,
                    },
                    {
                        id: "tie-a",
                        content: "same searchable phrase",
                        rank: 2,
                        distance: 0.2,
                    },
                ],
            }
        );
        (
            tiedSearch as unknown as {
                searchLexical: (...args: unknown[]) => Promise<unknown[]>;
            }
        ).searchLexical = async () =>
            [
                {
                    id: "tie-a",
                    content: "same searchable phrase",
                    chunkIndex: 0,
                    rank: 1,
                },
                {
                    id: "tie-b",
                    content: "same searchable phrase",
                    chunkIndex: 1,
                    rank: 2,
                },
            ] as never;
        const tied = await tiedSearch.searchWithDiagnostics(
            "ties",
            "searchable",
            { minScore: 0 }
        );

        const thresholds = [
            result("at", 0, 0.03),
            result("below", 1, 0.029999),
            result("above", 2, 0.04),
        ];
        const chunkSet: BookSearchChunk[] = [0, 1, 2].map((chunkIndex) => ({
            id: `c${chunkIndex}`,
            collectionName: "book",
            chunkIndex,
            content: `chunk ${chunkIndex}`,
            metadata: { chapterIndex: 1, pageNumber: chunkIndex + 1 },
        }));
        const firstEdge = expandRerankCandidates(
            [result("c0", 0, 0.04)],
            chunkSet
        );
        const lastEdge = expandRerankCandidates(
            [result("c2", 2, 0.04)],
            chunkSet
        );
        const overflow = buildBoundedRerankerDocuments(
            expandRerankCandidates(
                Array.from({ length: 30 }, (_, index) =>
                    result(`o${index}`, index, 0.04, "x".repeat(2_000))
                ),
                []
            )
        );

        const candidates = [
            result("a", 0, 0.04, "red fox runs through the quiet forest"),
            result("b", 1, 0.04, "red fox runs through the deep forest"),
            result("c", 2, 0.04, "planets orbit the distant star"),
        ];
        const expandedCandidates = expandRerankCandidates(candidates, []);
        const scores = new Map([
            ["a", 0.99],
            ["b", 0.98],
            ["c", 0.3],
        ]);
        const mmr = selectWithDeterministicMmr(expandedCandidates, scores, 2);
        const guarded = selectDiversityGuardedMmr(
            expandedCandidates,
            scores,
            0.1,
            2
        );
        const unguarded = selectDiversityGuardedMmr(
            expandedCandidates,
            scores,
            1,
            2
        );

        const hybridResponse = {
            results: [result("seed", 0, 0.03)],
            diagnostics: {
                mode: "hybrid" as const,
                durationMs: 0,
                lexicalCandidates: [],
                vectorCandidates: [],
                selectedCandidates: [],
            },
        };
        const strictError = await retrieveRerankedEvidence({
            collectionName: "book",
            query: "q",
            minHybridScore: 0.03,
            searchService: {
                searchWithDiagnostics: async () => hybridResponse,
            },
            chunkReader: {
                getCollectionChunks: async () => {
                    throw new Error("chunk reader unavailable");
                },
            },
            strictInfrastructureErrors: true,
        }).then(
            () => "no error",
            (error: Error) => error.message
        );
        const cancelSignal = AbortSignal.abort();
        const cancelled = await retrieveRerankedEvidence({
            collectionName: "book",
            query: "q",
            minHybridScore: 0.03,
            searchService: {
                searchWithDiagnostics: async () => hybridResponse,
            },
            chunkReader: { getCollectionChunks: async () => [] },
            reranker: {
                rerank: async () => {
                    const error = new Error("cancelled");
                    error.name = "AbortError";
                    throw error;
                },
            },
            signal: cancelSignal,
        });
        const timedOut = await retrieveRerankedEvidence({
            collectionName: "book",
            query: "q",
            minHybridScore: 0.03,
            searchService: {
                searchWithDiagnostics: async () => hybridResponse,
            },
            chunkReader: { getCollectionChunks: async () => [] },
            reranker: {
                rerank: async () => {
                    throw new Error("request timed out");
                },
            },
        });
        const documents = [
            { id: "r0", content: "first document" },
            { id: "r1", content: "second document" },
        ];
        const aliases = JSON.parse(
            String(buildRerankerRequest("q", documents, 2).messages[1].content)
        ).documents.map(
            (document: { alias: string }) => document.alias
        ) as string[];
        const malformedResult = async (parsed: unknown) => {
            const client = {
                beta: {
                    chat: {
                        completions: {
                            parse: async () => {
                                const rankings = (
                                    parsed as { rankings?: unknown[] } | null
                                )?.rankings;
                                if (
                                    Array.isArray(rankings) &&
                                    rankings.length !== 2
                                ) {
                                    throw new Error("response incomplete");
                                }
                                return {
                                    model: "fake-model",
                                    choices: [{ message: { parsed } }],
                                    usage: null,
                                };
                            },
                        },
                    },
                },
            };
            return new OpenAIChatReranker(client as never)
                .rerank({ query: "q", documents, topN: 2 })
                .then(
                    () => "accepted",
                    (error: Error) => error.message
                );
        };
        const malformed = await Promise.all([
            malformedResult({ rankings: [] }),
            malformedResult({
                rankings: [
                    { alias: "unknown", score: 0.8 },
                    { alias: aliases[1], score: 0.7 },
                ],
            }),
            malformedResult({
                rankings: [
                    { alias: aliases[0], score: 0.8 },
                    { alias: aliases[0], score: 0.7 },
                ],
            }),
        ]);

        const promptHistory = [
            { role: "user" as const, content: "Earlier question" },
            { role: "assistant" as const, content: "Earlier answer" },
        ];
        const highlight = {
            sourceType: "epub" as const,
            text: "Selected passage",
        };
        const promptWithHighlight = buildBookContextSystemPrompt(
            "retrieved excerpt",
            highlight
        );
        const promptWithoutHighlight = buildBookContextSystemPrompt(
            "retrieved excerpt",
            null
        );
        const withHistory = buildChatCompletionRequest(
            promptHistory,
            promptWithHighlight
        );
        const withoutHistory = buildChatCompletionRequest(
            [],
            promptWithoutHighlight
        );

        const streamAnswer = async (complete: boolean) => {
            const service = {
                generateStreamResponse: async () =>
                    (async function* () {
                        yield {
                            model: "resolved-model",
                            choices: [
                                {
                                    delta: { content: "partial answer" },
                                    finish_reason: complete ? "stop" : null,
                                },
                            ],
                            usage: { prompt_tokens: 2, completion_tokens: 2 },
                        };
                        throw Object.assign(new Error("Premature close"), {
                            code: "ERR_STREAM_PREMATURE_CLOSE",
                        });
                    })(),
            };
            return generateBookAnswer({
                messages: [],
                model: "gpt-4o-mini",
                service: service as never,
            }).then(
                (answer) => ({
                    answer: answer.answer,
                    streamCompleted: answer.streamCompleted,
                    transportWarning: answer.transportWarning ?? null,
                }),
                (error: Error) => ({ error: error.message })
            );
        };
        const usage = normalizeModelUsage({
            prompt_tokens: 1_000,
            completion_tokens: 300,
            total_tokens: 1_300,
            prompt_tokens_details: { cached_tokens: 200 },
        });
        const models = [
            "gpt-4o-mini",
            "gpt-4o-mini-2024-07-18",
            "gpt-5.4-mini-2026-03-17",
            "gpt-5.5-2026-04-23",
        ];

        const snapshots = normalize({
            empty: {
                mode: empty.diagnostics.mode,
                ids: empty.results.map((r) => r.id),
            },
            vectorOnly: {
                mode: vectorOnly.diagnostics.mode,
                ids: vectorOnly.results.map((r) => r.id),
            },
            thresholdInclusive: deriveBaselineResults(
                thresholds,
                "hybrid",
                0.03
            ).map((r) => r.id),
            tieOrder: deriveBaselineResults(
                [result("tie-a", 0, 0.04), result("tie-b", 1, 0.04)],
                "hybrid",
                0
            ).map((r) => r.id),
            hybridTieOrder: {
                ids: tied.results.map((r) => r.id),
                equalScores: tied.results[0]?.score === tied.results[1]?.score,
            },
            neighborAtZero: firstEdge.map((candidate) => candidate.id),
            neighborAtLast: lastEdge.map((candidate) => candidate.id),
            budget: {
                candidates: overflow.length,
                withinLimit:
                    overflow.reduce(
                        (sum, candidate) => sum + candidate.content.length,
                        0
                    ) <= 40_000,
            },
            timeout: timedOut.diagnostics.reranker.fallbackReason,
            cancellation: {
                category: cancelled.diagnostics.reranker.fallbackReason,
                callerAborted: cancelSignal.aborted,
            },
            strictInfrastructureError: strictError,
            malformedReranker: malformed.map((message) => ({
                message,
                fallback: classifyRerankerFallback(new Error(message)),
            })),
            mmr: mmr.map((candidate) => candidate.id),
            diversityGuard: {
                engaged:
                    guarded.map((candidate) => candidate.id).join(",") !==
                    mmr.map((candidate) => candidate.id).join(","),
                selected: guarded.map((candidate) => candidate.id),
                notEngaged:
                    unguarded.map((candidate) => candidate.id).join(",") ===
                    mmr.map((candidate) => candidate.id).join(","),
            },
            promptWithHighlight: {
                containsHighlight:
                    promptWithHighlight.includes("Selected passage"),
                roles: withHistory.messages.map((message) => message.role),
                history: withHistory.messages
                    .slice(1)
                    .map((message) => message.content),
                query: buildRetrievalQuery("What happened?", highlight),
            },
            promptWithoutHighlight: {
                containsHighlight:
                    promptWithoutHighlight.includes("Selected passage"),
                roles: withoutHistory.messages.map((message) => message.role),
            },
            completedStream: await streamAnswer(true),
            incompleteStream: await streamAnswer(false),
            costs: Object.fromEntries(
                models.map((model) => [
                    model,
                    estimateModelCost(model, usage)?.amount ?? null,
                ])
            ),
            shadowComparison: compareShadowSourceRanks(
                [
                    { id: "a", rank: 1 },
                    { id: "b", rank: 2 },
                ],
                [
                    { id: "b", rank: 1 },
                    { id: "c", rank: 2 },
                ]
            ),
        });

        if (process.env.UPDATE_RAG_CHARACTERIZATION === "1") {
            writeFileSync(
                goldenPath,
                `${JSON.stringify(snapshots, null, 4)}\n`
            );
        } else {
            assert.deepEqual(snapshots, golden);
            assert.equal(Object.keys(golden).length, 20);
        }
    } finally {
        Date.now = originalNow;
        if (originalPipeline === undefined) {
            delete process.env.RAG_PIPELINE_VERSION;
        } else {
            process.env.RAG_PIPELINE_VERSION = originalPipeline;
        }
    }
});
