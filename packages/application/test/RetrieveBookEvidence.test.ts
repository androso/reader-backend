import assert from "node:assert/strict";
import test from "node:test";
import {
    ChatCancelledError,
    RAG_PIPELINES,
    type RagChunk,
    type RagRankedResult,
} from "@reader/domain";
import type { RetrieveBookEvidenceDependencies } from "../src/rag/RetrieveBookEvidence";
import { RetrieveBookEvidence } from "../src/rag/RetrieveBookEvidence";

const chunks: RagChunk[] = [
    {
        id: "book_0",
        collectionName: "book",
        chunkIndex: 0,
        content: "one two three four five",
        metadata: { chapterIndex: 1 },
    },
];

const makeDependencies = (
    overrides: Partial<RetrieveBookEvidenceDependencies> = {}
): RetrieveBookEvidenceDependencies => ({
    books: {
        findOwned: async () => ({
            id: "book-id",
            userId: "user-id",
            collectionName: "book",
            processingStatus: "ready",
        }),
    },
    chunks: { getCollectionChunks: async () => chunks },
    lexical: {
        search: async () => [
            {
                id: "book_0",
                content: chunks[0].content,
                chunkIndex: 0,
                rank: 1,
            },
        ],
    },
    vector: {
        search: async () => [
            { id: "book_0", content: chunks[0].content, rank: 1 },
        ],
    },
    reranker: {
        rerank: async ({ documents }) => ({
            rankings: documents.map((document, index) => ({
                id: document.id,
                score: 1 - index / 10,
                rank: index + 1,
            })),
            requestedModel: "gpt-5.4-mini-2026-03-17",
            resolvedModel: "gpt-5.4-mini-2026-03-17",
            usage: null,
            durationMs: 1,
        }),
    },
    config: {
        getPipeline: () => RAG_PIPELINES["rerank-rag-v1"],
        getMinHybridScore: () => 0.03,
    },
    clock: { now: () => new Date(1_000) },
    ...overrides,
});

const broadResult: RagRankedResult = {
    id: "book_0",
    content: chunks[0].content,
    chunkIndex: 0,
    score: 0.04,
    bestRank: 1,
    metadata: { chapterIndex: 1 },
};

test("retrieves owned ready-book evidence with reranking diagnostics", async () => {
    const useCase = new RetrieveBookEvidence(makeDependencies());
    const result = await useCase.execute({
        bookId: "book-id",
        userId: "user-id",
        query: "question",
    });

    assert.equal(result.status, "ready");
    assert.equal(result.results?.[0]?.id, "book_0");
    assert.equal(result.telemetry.retrieval?.mode, "reranked");
});

test("caller cancellation rejects promptly and ignores a late reranker result", async () => {
    let finishReranker!: () => void;
    let rerankerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        rerankerStarted = resolve;
    });
    const controller = new AbortController();
    const useCase = new RetrieveBookEvidence(
        makeDependencies({
            reranker: {
                rerank: async () => {
                    rerankerStarted();
                    await new Promise<void>((resolve) => {
                        finishReranker = resolve;
                    });
                    return {
                        rankings: [{ id: "book_0", score: 1, rank: 1 }],
                        requestedModel: "gpt-5.4-mini-2026-03-17",
                        resolvedModel: "gpt-5.4-mini-2026-03-17",
                        usage: null,
                        durationMs: 1,
                    };
                },
            },
        })
    );
    const retrieval = useCase.execute({
        bookId: "book-id",
        userId: "user-id",
        query: "question",
        signal: controller.signal,
    });
    await started;
    controller.abort();
    await assert.rejects(retrieval, ChatCancelledError);
    finishReranker();
    await Promise.resolve();
});

test("provider-local timeouts return baseline fallback", async () => {
    const useCase = new RetrieveBookEvidence(
        makeDependencies({
            reranker: {
                rerank: async () => {
                    throw new Error("request timed out");
                },
            },
        })
    );
    const result = await useCase.execute({
        bookId: "book-id",
        userId: "user-id",
        query: "question",
    });

    assert.equal(result.status, "ready");
    assert.equal(
        result.telemetry.retrieval?.mode === "reranked"
            ? result.telemetry.retrieval.reranker.fallbackReason
            : null,
        "timeout"
    );
});

test("retrieval failures preserve the configurable service log detail", async () => {
    const errors: Array<[string, Record<string, unknown> | undefined]> = [];
    const useCase = new RetrieveBookEvidence(
        makeDependencies({
            vector: {
                search: async () => {
                    throw new Error("vector unavailable");
                },
            },
            loggers: {
                bookRag: {
                    warn: () => undefined,
                    error: (message, metadata) =>
                        errors.push([message, metadata]),
                },
                rerankedRetrieval: {
                    warn: () => undefined,
                    error: () => undefined,
                },
            },
        })
    );

    const result = await useCase.execute({
        bookId: "book-id",
        userId: "user-id",
        query: "question",
        includeErrorDetailInLogs: false,
    });

    assert.equal(result.status, "retrieval_unavailable");
    assert.deepEqual(errors, [
        [
            "Error retrieving book context",
            {
                bookId: "book-id",
                collectionName: "book",
                errorName: "Error",
            },
        ],
    ]);
});
