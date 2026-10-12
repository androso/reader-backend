import {
    ChatCancelledError,
    RAG_PIPELINES,
    type ChatRetrievalStatus,
    type ChatRetrievalDiagnostics,
    type ChatSource,
    type ChatRerankedRetrievalDiagnostics,
    type RagCandidate,
    type RagRankedResult,
    type RagRetrievalDiagnostics,
    type RagPipelineVersion,
    type RerankerFailureCategory,
} from "@reader/domain";
import type {
    BookChunkReader,
    Clock,
    LexicalSearch,
    OwnedBookLookup,
    RagConfiguration,
    RagLoggers,
    RagTracing,
    RagUsageAccounting,
    Reranker,
    VectorSearch,
} from "./ports";
import {
    deriveHybridSearchResponse,
    hydrateVectorResults,
} from "./policies/hybridSearch";
import {
    RERANK_FINAL_LIMIT,
    RERANK_FIRST_STAGE_LIMIT,
    baselineDiagnostics,
    buildBoundedRerankerDocuments,
    classifyRerankerFallback,
    deriveBaselineResults,
    describeRerankerError,
    diagnosticCandidates,
    expandRerankCandidates,
    maxWordTrigramSimilarity,
    selectDiversityGuardedMmr,
    selectWithDeterministicMmr,
    wordTrigramJaccard,
    type Candidate,
    type SelectedRerankedResult,
} from "./policies/reranking";

export type RetrieveBookEvidenceInput = {
    bookId: string;
    userId: string;
    query: string;
    signal?: AbortSignal;
    trace?: RagTracing;
    strict?: boolean;
    pipelineVersion?: RagPipelineVersion;
    minHybridScore?: number;
    strictInfrastructureErrors?: boolean;
    includeErrorDetailInLogs?: boolean;
};

export type RetrieveBookEvidenceResult = {
    status: ChatRetrievalStatus;
    sources: ChatSource[] | null;
    telemetry: ChatRetrievalDiagnostics;
    results?: Array<RagRankedResult | SelectedRerankedResult>;
    error?: string | null;
};

type FirstStageResponse = {
    results: RagRankedResult[];
    diagnostics: Extract<
        RagRetrievalDiagnostics,
        { mode: "hybrid" | "vector_only" }
    >;
};

type RerankedEvidenceResult = {
    results: Array<RagRankedResult | SelectedRerankedResult>;
    diagnostics: ChatRerankedRetrievalDiagnostics;
};

export interface RetrieveBookEvidenceDependencies {
    books: OwnedBookLookup;
    chunks: BookChunkReader;
    lexical: LexicalSearch;
    vector: VectorSearch;
    reranker: Reranker;
    config: RagConfiguration;
    clock: Clock;
    accounting?: RagUsageAccounting;
    loggers?: RagLoggers;
}

const throwIfCancelled = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw new ChatCancelledError();
};

const waitForReranker = <T>(
    promise: Promise<T>,
    signal?: AbortSignal
): Promise<T> => {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new ChatCancelledError());
    return new Promise((resolve, reject) => {
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        const onAbort = () => {
            cleanup();
            reject(new ChatCancelledError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error) => {
                cleanup();
                reject(error);
            }
        );
    });
};

const mapSources = (
    results: Array<RagRankedResult | SelectedRerankedResult>
): ChatSource[] =>
    results.map((result) => ({
        id: result.id,
        chunkIndex: result.chunkIndex,
        score: result.score,
        bestRank: result.bestRank,
        ...("rerankerRank" in result
            ? { rerankerRank: result.rerankerRank }
            : {}),
        ...("rerankerScore" in result
            ? { rerankerScore: result.rerankerScore }
            : {}),
        ...("selectionReason" in result
            ? { selectionReason: result.selectionReason }
            : {}),
        excerpt: result.content,
        metadata: result.metadata,
    }));

export class RetrieveBookEvidence {
    constructor(private readonly deps: RetrieveBookEvidenceDependencies) {}

    async execute(
        input: RetrieveBookEvidenceInput
    ): Promise<RetrieveBookEvidenceResult> {
        throwIfCancelled(input.signal);
        const pipeline = this.deps.config.getPipeline(input.pipelineVersion);
        const baseTelemetry: ChatRetrievalDiagnostics = {
            pipelineVersion: pipeline.pipelineVersion,
            promptVersion: pipeline.promptVersion,
            queryPlan: null,
            retrieval: null,
        };
        const loadBookSpan = input.trace?.startObservation("load_book", {
            input: { resourceType: "book", resourceId: input.bookId },
        });
        let book: Awaited<ReturnType<OwnedBookLookup["findOwned"]>>;
        try {
            book = await this.deps.books.findOwned({
                userId: input.userId,
                bookId: input.bookId,
            });
            throwIfCancelled(input.signal);
            loadBookSpan?.update({
                output: {
                    found: Boolean(book),
                    processingStatus: book?.processingStatus,
                    hasCollection: Boolean(book?.collectionName),
                    collectionName: book?.collectionName,
                    processingError: book?.processingError,
                },
            });
        } catch (error) {
            if (!input.signal?.aborted) {
                loadBookSpan?.update({
                    level: "ERROR",
                    statusMessage: "Book lookup failed",
                    output: {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                });
            }
            throw input.signal?.aborted ? new ChatCancelledError() : error;
        } finally {
            loadBookSpan?.end();
        }

        if (!book) {
            this.deps.loggers?.bookRag.warn("Book not found for RAG", {
                bookId: input.bookId,
                userId: input.userId,
            });
            return {
                status: "not_found",
                sources: null,
                telemetry: baseTelemetry,
            };
        }
        if (book.processingStatus === "failed") {
            return {
                status: "ingestion_failed",
                sources: null,
                telemetry: baseTelemetry,
                error: book.processingError,
            };
        }
        if (!book.collectionName) {
            return {
                status: "processing",
                sources: null,
                telemetry: baseTelemetry,
            };
        }

        const minHybridScore =
            input.minHybridScore ?? this.deps.config.getMinHybridScore();
        const retrievalSpan = input.trace?.startObservation(
            "hybrid_retrieval",
            {
                input: {
                    collectionName: book.collectionName,
                    queryLength: input.query.length,
                    lexicalLimit: 20,
                    vectorLimit: 20,
                    finalLimit: RERANK_FINAL_LIMIT,
                },
            }
        );
        try {
            const startedAt = this.deps.clock.now().getTime();
            const firstStage = await this.searchFirstStage(
                book.collectionName,
                input.query,
                pipeline.retrievalStrategy === "reranked"
                    ? RERANK_FIRST_STAGE_LIMIT
                    : 20,
                pipeline.retrievalStrategy === "reranked"
                    ? RERANK_FIRST_STAGE_LIMIT
                    : RERANK_FINAL_LIMIT,
                pipeline.retrievalStrategy === "reranked" ? 0 : minHybridScore,
                pipeline.retrievalStrategy === "baseline"
                    ? retrievalSpan
                    : undefined,
                input.signal
            );
            let response: FirstStageResponse | RerankedEvidenceResult =
                firstStage;
            if (pipeline.retrievalStrategy === "reranked") {
                response = await this.rerankResponse({
                    collectionName: book.collectionName,
                    query: input.query,
                    broad: firstStage,
                    minHybridScore,
                    signal: input.signal,
                    startedAt,
                    strictInfrastructureErrors:
                        input.strictInfrastructureErrors ?? false,
                });
            }
            throwIfCancelled(input.signal);
            retrievalSpan?.update({ output: response.diagnostics });
            const telemetry = {
                ...baseTelemetry,
                retrieval: response.diagnostics,
            };
            if (!response.results.length) {
                return {
                    status: "ready",
                    sources: null,
                    telemetry,
                    results: [],
                };
            }
            return {
                status: "ready",
                sources: mapSources(response.results),
                telemetry,
                results: response.results,
            };
        } catch (error) {
            if (input.signal?.aborted) throw new ChatCancelledError();
            retrievalSpan?.update({
                level: "ERROR",
                statusMessage: "Hybrid retrieval failed",
                output: {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
            this.deps.loggers?.bookRag.error("Error retrieving book context", {
                bookId: input.bookId,
                collectionName: book.collectionName,
                ...((input.includeErrorDetailInLogs ?? true)
                    ? {
                          error:
                              error instanceof Error
                                  ? error.message
                                  : String(error),
                      }
                    : {
                          errorName:
                              error instanceof Error
                                  ? error.name
                                  : typeof error,
                      }),
            });
            if (input.strict) throw error;
            return {
                status: "retrieval_unavailable",
                sources: null,
                telemetry: baseTelemetry,
                error: "Book retrieval is temporarily unavailable.",
            };
        } finally {
            retrievalSpan?.end();
        }
    }

    async retrieveReranked(input: {
        collectionName: string;
        query: string;
        minHybridScore?: number;
        signal?: AbortSignal;
        strictInfrastructureErrors?: boolean;
        reranker?: Reranker;
        chunks?: BookChunkReader;
        firstStage?: FirstStageResponse;
        startedAt?: number;
    }): Promise<RerankedEvidenceResult> {
        throwIfCancelled(input.signal);
        const minHybridScore =
            input.minHybridScore ?? this.deps.config.getMinHybridScore();
        const startedAt = input.startedAt ?? this.deps.clock.now().getTime();
        const broad =
            input.firstStage ??
            (await this.searchFirstStage(
                input.collectionName,
                input.query,
                RERANK_FIRST_STAGE_LIMIT,
                RERANK_FIRST_STAGE_LIMIT,
                0,
                undefined,
                input.signal
            ));
        return this.rerankResponse({
            ...input,
            broad,
            minHybridScore,
            startedAt,
            strictInfrastructureErrors:
                input.strictInfrastructureErrors ?? false,
            chunks: input.chunks,
        });
    }

    private async searchFirstStage(
        collectionName: string,
        query: string,
        limit: number,
        finalLimit: number,
        minScore: number,
        trace?: RagTracing,
        signal?: AbortSignal
    ): Promise<FirstStageResponse> {
        throwIfCancelled(signal);
        const startedAt = this.deps.clock.now().getTime();
        const [lexicalResults, vectorResults] = await Promise.all([
            this.deps.lexical.search(collectionName, query, limit, { trace }),
            this.deps.vector.search(collectionName, query, limit, { trace }),
        ]);
        throwIfCancelled(signal);
        const chunks = this.deps.lexical.getCollectionChunks
            ? await this.deps.lexical.getCollectionChunks(collectionName)
            : await this.deps.chunks.getCollectionChunks(collectionName);
        throwIfCancelled(signal);
        const hydrated = hydrateVectorResults(vectorResults, chunks);
        return deriveHybridSearchResponse(
            lexicalResults,
            vectorResults,
            hydrated,
            {
                finalLimit,
                minScore,
                durationMs: this.deps.clock.now().getTime() - startedAt,
            }
        );
    }

    private async rerankResponse(input: {
        collectionName: string;
        query: string;
        broad: FirstStageResponse;
        minHybridScore: number;
        signal?: AbortSignal;
        strictInfrastructureErrors: boolean;
        reranker?: Reranker;
        chunks?: BookChunkReader;
        startedAt: number;
    }): Promise<RerankedEvidenceResult> {
        const pipeline = RAG_PIPELINES["rerank-rag-v1"];
        const startedAt = input.startedAt;
        const baseline = deriveBaselineResults(
            input.broad.results,
            input.broad.diagnostics.mode,
            input.minHybridScore
        );
        const firstStage = baselineDiagnostics(
            input.broad.diagnostics,
            baseline
        );
        const makeFallback = (
            status: "skipped" | "fallback",
            fallbackReason: string,
            rerankerDurationMs = 0
        ): RerankedEvidenceResult => ({
            results: baseline,
            diagnostics: {
                mode: "reranked",
                durationMs: this.deps.clock.now().getTime() - startedAt,
                firstStage,
                firstStageCandidates: input.broad.results.map(
                    (result, index) => ({
                        id: result.id,
                        firstStageRank: index + 1,
                        chunkIndex: result.chunkIndex,
                        origin: "first_stage" as const,
                    })
                ),
                finalCandidates: baseline.map((result, index) => ({
                    id: result.id,
                    rank: index + 1,
                    firstStageRank:
                        input.broad.results.findIndex(
                            (candidate) => candidate.id === result.id
                        ) + 1,
                    chunkIndex: result.chunkIndex,
                    origin: "first_stage" as const,
                    selectionReason: "exact_baseline_fallback",
                    maxWordTrigramJaccard: 0,
                })),
                reranker: {
                    requestedModel:
                        pipeline.rerankerModel ?? "gpt-5.4-mini-2026-03-17",
                    resolvedModel: null,
                    promptVersion:
                        pipeline.rerankerPromptVersion ?? "rerank-documents-v1",
                    status,
                    durationMs: rerankerDurationMs,
                    usage: null,
                    estimatedCost: null,
                    fallbackReason,
                },
                diversity: { maxWordTrigramJaccard: 0 },
            },
        });

        if (input.broad.diagnostics.mode === "hybrid" && !baseline.length) {
            return makeFallback("skipped", "no_baseline_eligible_hybrid_seed");
        }
        if (!input.broad.results.length) {
            return makeFallback("skipped", "no_candidates");
        }

        let candidates: Candidate[];
        let boundedDocuments: ReturnType<typeof buildBoundedRerankerDocuments>;
        try {
            throwIfCancelled(input.signal);
            const chunks = await (
                input.chunks ?? this.deps.chunks
            ).getCollectionChunks(input.collectionName);
            throwIfCancelled(input.signal);
            candidates = expandRerankCandidates(input.broad.results, chunks);
            boundedDocuments = buildBoundedRerankerDocuments(candidates);
        } catch (error) {
            if (input.signal?.aborted) throw new ChatCancelledError();
            if (input.strictInfrastructureErrors) throw error;
            this.deps.loggers?.rerankedRetrieval.warn(
                "Reranker candidate preparation failed; returning exact baseline evidence",
                {
                    requestedModel:
                        pipeline.rerankerModel ?? "gpt-5.4-mini-2026-03-17",
                    promptVersion:
                        pipeline.rerankerPromptVersion ?? "rerank-documents-v1",
                    errorName:
                        error instanceof Error ? error.name : typeof error,
                }
            );
            return makeFallback("fallback", "provider_error");
        }

        let rerankerStartedAt: number | null = null;
        const rerankerCandidateCount = boundedDocuments.length;
        const rerankerDocumentCharacters = boundedDocuments.reduce(
            (total, document) => total + document.content.length,
            0
        );
        try {
            throwIfCancelled(input.signal);
            const activeReranker = input.reranker ?? this.deps.reranker;
            rerankerStartedAt = this.deps.clock.now().getTime();
            const reranked = await waitForReranker(
                activeReranker.rerank({
                    query: input.query,
                    documents: boundedDocuments,
                    topN: boundedDocuments.length,
                    signal: input.signal,
                }),
                input.signal
            );
            throwIfCancelled(input.signal);
            const scores = new Map(
                reranked.rankings.map((ranking) => [ranking.id, ranking.score])
            );
            const ranks = new Map(
                reranked.rankings.map((ranking) => [ranking.id, ranking.rank])
            );
            const baselineMaxSimilarity = maxWordTrigramSimilarity(baseline);
            let results = selectWithDeterministicMmr(candidates, scores).map(
                (result) => ({
                    ...result,
                    rerankerRank: ranks.get(result.id) ?? result.rerankerRank,
                })
            );
            if (
                maxWordTrigramSimilarity(results) >
                baselineMaxSimilarity + Number.EPSILON
            ) {
                results = selectDiversityGuardedMmr(
                    candidates,
                    scores,
                    baselineMaxSimilarity,
                    RERANK_FINAL_LIMIT
                ).map((result) => ({
                    ...result,
                    rerankerRank: ranks.get(result.id) ?? result.rerankerRank,
                    selectionReason: `diversity_guard;${result.selectionReason}`,
                }));
            }
            const finalCandidates = results.map((result, index) => {
                const source = candidates.find(
                    (candidate) => candidate.id === result.id
                )!;
                const previous = results.slice(0, index);
                const maxSimilarity = previous.length
                    ? Math.max(
                          ...previous.map((candidate) =>
                              wordTrigramJaccard(
                                  result.content,
                                  candidate.content
                              )
                          )
                      )
                    : 0;
                return {
                    id: result.id,
                    rank: index + 1,
                    firstStageRank: source.firstStageRank,
                    chunkIndex: result.chunkIndex,
                    origin: source.origin,
                    ...(source.neighborOf
                        ? { neighborOf: source.neighborOf }
                        : {}),
                    rerankerRank: result.rerankerRank,
                    rerankerScore: result.rerankerScore,
                    selectionReason: result.selectionReason,
                    maxWordTrigramJaccard: maxSimilarity,
                };
            });
            const maxSimilarity = maxWordTrigramSimilarity(results);
            const usage =
                this.deps.accounting?.normalizeUsage(reranked.usage) ?? null;
            return {
                results,
                diagnostics: {
                    mode: "reranked",
                    durationMs: this.deps.clock.now().getTime() - startedAt,
                    firstStage,
                    firstStageCandidates: diagnosticCandidates(candidates),
                    finalCandidates,
                    reranker: {
                        requestedModel: reranked.requestedModel,
                        resolvedModel: reranked.resolvedModel,
                        promptVersion:
                            pipeline.rerankerPromptVersion ??
                            "rerank-documents-v1",
                        status: "success",
                        durationMs: reranked.durationMs,
                        usage,
                        estimatedCost:
                            this.deps.accounting?.estimateCost(
                                reranked.resolvedModel,
                                usage
                            ) ?? null,
                        fallbackReason: null,
                    },
                    diversity: { maxWordTrigramJaccard: maxSimilarity },
                },
            };
        } catch (error) {
            if (input.signal?.aborted) throw new ChatCancelledError();
            const fallbackReason: RerankerFailureCategory =
                classifyRerankerFallback(error);
            const rerankerDurationMs =
                rerankerStartedAt === null
                    ? 0
                    : this.deps.clock.now().getTime() - rerankerStartedAt;
            this.deps.loggers?.rerankedRetrieval.warn(
                "Reranker failed; returning exact baseline evidence",
                {
                    fallbackReason,
                    requestedModel:
                        pipeline.rerankerModel ?? "gpt-5.4-mini-2026-03-17",
                    promptVersion:
                        pipeline.rerankerPromptVersion ?? "rerank-documents-v1",
                    durationMs: rerankerDurationMs,
                    candidateCount: rerankerCandidateCount,
                    documentCharacters: rerankerDocumentCharacters,
                    callerAborted: input.signal?.aborted ?? false,
                    ...describeRerankerError(error),
                }
            );
            return makeFallback("fallback", fallbackReason, rerankerDurationMs);
        }
    }
}

export type { Candidate, SelectedRerankedResult };
