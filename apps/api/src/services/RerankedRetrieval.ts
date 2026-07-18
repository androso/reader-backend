import {
    OpenAIChatReranker,
    RERANKER_MAX_DOCUMENT_CHARACTERS,
    RERANKER_MODEL,
    RERANKER_PROMPT_VERSION,
    type BookSearchChunk,
    type HybridBookSearchService,
    type HybridSearchDiagnostics,
    type RankedSearchResult,
    type RerankerProvider,
} from "@reader/providers";
import { estimateModelCost, normalizeModelUsage } from "./AiUsage";
import { bookSearchChunkStore } from "./BookSearchChunkStore";
import { hybridBookSearchService } from "./HybridBookSearchService";
import { getRagMinHybridScore } from "./RagRetrievalConfig";
import type {
    RerankedCandidateDiagnostic,
    RerankedRetrievalDiagnostics,
} from "../types/ragTelemetry";

export const RERANK_FIRST_STAGE_LIMIT = 20;
export const RERANK_FINAL_LIMIT = 5;
export const RERANK_CANDIDATE_LIMIT = 30;
export const BASELINE_MIN_HYBRID_SCORE = 0.03;
export const MMR_RELEVANCE_WEIGHT = 0.8;
export const MMR_DIVERSITY_WEIGHT = 0.2;

export type SelectedRerankedResult = RankedSearchResult & {
    rerankerRank: number;
    rerankerScore: number;
    selectionReason: string;
};

type Candidate = RankedSearchResult & {
    firstStageRank: number;
    origin: "first_stage" | "neighbor";
    neighborOf?: string;
};

const isSameChapter = (left: BookSearchChunk, right: RankedSearchResult) => {
    if (
        left.metadata?.chapterIndex !== undefined &&
        right.metadata?.chapterIndex !== undefined
    ) {
        return left.metadata.chapterIndex === right.metadata.chapterIndex;
    }
    return Boolean(
        left.metadata?.chapterTitle &&
            left.metadata.chapterTitle === right.metadata?.chapterTitle
    );
};

const isSamePage = (left: BookSearchChunk, right: RankedSearchResult) =>
    left.metadata?.pageNumber !== undefined &&
    left.metadata.pageNumber === right.metadata?.pageNumber;

export const deriveBaselineResults = (
    broadResults: RankedSearchResult[],
    mode: HybridSearchDiagnostics["mode"],
    minHybridScore: number
) =>
    (mode === "hybrid"
        ? broadResults.filter((result) => result.score >= minHybridScore)
        : broadResults
    ).slice(0, RERANK_FINAL_LIMIT);

export const expandRerankCandidates = (
    firstStage: RankedSearchResult[],
    chunks: BookSearchChunk[]
): Candidate[] => {
    const candidates: Candidate[] = firstStage.map((result, index) => ({
        ...result,
        firstStageRank: index + 1,
        origin: "first_stage",
    }));
    const seen = new Set(candidates.map((candidate) => candidate.id));
    const chunksByIndex = new Map(
        chunks.map((chunk) => [chunk.chunkIndex, chunk])
    );

    for (const [seedIndex, seed] of firstStage.slice(0, 5).entries()) {
        for (const chunkIndex of [seed.chunkIndex - 1, seed.chunkIndex + 1]) {
            const neighbor = chunksByIndex.get(chunkIndex);
            if (
                !neighbor ||
                seen.has(neighbor.id) ||
                (!isSameChapter(neighbor, seed) && !isSamePage(neighbor, seed))
            ) {
                continue;
            }
            candidates.push({
                id: neighbor.id,
                content: neighbor.content,
                chunkIndex: neighbor.chunkIndex,
                metadata: neighbor.metadata,
                score: 0,
                bestRank: seed.bestRank,
                firstStageRank: seedIndex + 1,
                origin: "neighbor",
                neighborOf: seed.id,
            });
            seen.add(neighbor.id);
            if (candidates.length >= RERANK_CANDIDATE_LIMIT) return candidates;
        }
    }
    return candidates.slice(0, RERANK_CANDIDATE_LIMIT);
};

export const buildBoundedRerankerDocuments = (candidates: Candidate[]) => {
    let remaining = RERANKER_MAX_DOCUMENT_CHARACTERS;
    return candidates.map((candidate, index) => {
        const remainingCandidates = candidates.length - index;
        const characterBudget = Math.floor(remaining / remainingCandidates);
        const content = candidate.content.slice(0, characterBudget);
        remaining -= content.length;
        return { id: candidate.id, content };
    });
};

export const classifyRerankerFallback = (error: unknown) => {
    const detail =
        error instanceof Error
            ? `${error.name} ${error.message}`.toLowerCase()
            : String(error).toLowerCase();
    if (
        detail.includes("timeout") ||
        detail.includes("timed out") ||
        detail.includes("aborterror")
    ) {
        return "timeout";
    }
    if (detail.includes("refus")) return "refusal";
    if (
        detail.includes("invalid json") ||
        detail.includes("schema") ||
        detail.includes("ranking") ||
        detail.includes("candidate exactly once")
    ) {
        return "invalid_or_incomplete_ranking";
    }
    return "provider_error";
};

const wordTrigrams = (text: string) => {
    const words = text
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu);
    const trigrams = new Set<string>();
    if (!words) return trigrams;
    for (let index = 0; index <= words.length - 3; index += 1) {
        trigrams.add(words.slice(index, index + 3).join(" "));
    }
    return trigrams;
};

export const wordTrigramJaccard = (left: string, right: string) => {
    const leftSet = wordTrigrams(left);
    const rightSet = wordTrigrams(right);
    if (!leftSet.size && !rightSet.size) return left === right ? 1 : 0;
    let intersection = 0;
    for (const trigram of leftSet) {
        if (rightSet.has(trigram)) intersection += 1;
    }
    return intersection / (leftSet.size + rightSet.size - intersection);
};

export const selectWithDeterministicMmr = (
    candidates: Candidate[],
    scores: Map<string, number>,
    limit = RERANK_FINAL_LIMIT
): SelectedRerankedResult[] => {
    const rerankerOrder = [...candidates].sort((left, right) => {
        const scoreDelta =
            (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0);
        if (scoreDelta) return scoreDelta;
        if (left.firstStageRank !== right.firstStageRank) {
            return left.firstStageRank - right.firstStageRank;
        }
        return left.chunkIndex - right.chunkIndex;
    });
    const rankById = new Map(
        rerankerOrder.map((candidate, index) => [candidate.id, index + 1])
    );
    const remaining = new Map(
        candidates.map((candidate) => [candidate.id, candidate])
    );
    const selected: SelectedRerankedResult[] = [];

    while (selected.length < limit && remaining.size) {
        const ranked = [...remaining.values()]
            .map((candidate) => {
                const maxSimilarity = selected.length
                    ? Math.max(
                          ...selected.map((chosen) =>
                              wordTrigramJaccard(
                                  candidate.content,
                                  chosen.content
                              )
                          )
                      )
                    : 0;
                const relevance = scores.get(candidate.id) ?? 0;
                return {
                    candidate,
                    relevance,
                    maxSimilarity,
                    mmr:
                        MMR_RELEVANCE_WEIGHT * relevance -
                        MMR_DIVERSITY_WEIGHT * maxSimilarity,
                };
            })
            .sort((left, right) => {
                if (right.mmr !== left.mmr) return right.mmr - left.mmr;
                if (
                    left.candidate.firstStageRank !==
                    right.candidate.firstStageRank
                ) {
                    return (
                        left.candidate.firstStageRank -
                        right.candidate.firstStageRank
                    );
                }
                return left.candidate.chunkIndex - right.candidate.chunkIndex;
            });
        const winner = ranked[0];
        remaining.delete(winner.candidate.id);
        selected.push({
            ...winner.candidate,
            rerankerRank: rankById.get(winner.candidate.id)!,
            rerankerScore: winner.relevance,
            selectionReason: `mmr=${winner.mmr.toFixed(6)};maxWordTrigramJaccard=${winner.maxSimilarity.toFixed(6)}`,
        });
    }
    return selected;
};

const diagnosticCandidates = (
    candidates: Candidate[]
): RerankedCandidateDiagnostic[] =>
    candidates.map((candidate) => ({
        id: candidate.id,
        firstStageRank: candidate.firstStageRank,
        chunkIndex: candidate.chunkIndex,
        origin: candidate.origin,
        ...(candidate.neighborOf ? { neighborOf: candidate.neighborOf } : {}),
    }));

const baselineDiagnostics = (
    diagnostics: HybridSearchDiagnostics,
    baseline: RankedSearchResult[]
): HybridSearchDiagnostics => ({
    ...diagnostics,
    selectedCandidates: baseline.map((result, index) => ({
        id: result.id,
        rank: index + 1,
        score: result.score,
    })),
});

export const retrieveRerankedEvidence = async ({
    collectionName,
    query,
    minHybridScore = getRagMinHybridScore(),
    signal,
    searchService = hybridBookSearchService,
    chunkReader = bookSearchChunkStore,
    reranker,
}: {
    collectionName: string;
    query: string;
    minHybridScore?: number;
    signal?: AbortSignal;
    searchService?: Pick<HybridBookSearchService, "searchWithDiagnostics">;
    chunkReader?: {
        getCollectionChunks(name: string): Promise<BookSearchChunk[]>;
    };
    reranker?: RerankerProvider;
}): Promise<{
    results: Array<RankedSearchResult | SelectedRerankedResult>;
    diagnostics: RerankedRetrievalDiagnostics;
}> => {
    const startedAt = Date.now();
    const broad = await searchService.searchWithDiagnostics(
        collectionName,
        query,
        {
            lexicalLimit: RERANK_FIRST_STAGE_LIMIT,
            vectorLimit: RERANK_FIRST_STAGE_LIMIT,
            finalLimit: RERANK_FIRST_STAGE_LIMIT,
            minScore: 0,
        }
    );
    const baseline = deriveBaselineResults(
        broad.results,
        broad.diagnostics.mode,
        minHybridScore
    );
    const firstStage = baselineDiagnostics(broad.diagnostics, baseline);
    const makeFallback = (
        status: "skipped" | "fallback",
        fallbackReason: string,
        rerankerDurationMs = 0
    ) => ({
        results: baseline,
        diagnostics: {
            mode: "reranked" as const,
            durationMs: Date.now() - startedAt,
            firstStage,
            firstStageCandidates: broad.results.map((result, index) => ({
                id: result.id,
                firstStageRank: index + 1,
                chunkIndex: result.chunkIndex,
                origin: "first_stage" as const,
            })),
            finalCandidates: baseline.map((result, index) => ({
                id: result.id,
                rank: index + 1,
                firstStageRank:
                    broad.results.findIndex(
                        (candidate) => candidate.id === result.id
                    ) + 1,
                chunkIndex: result.chunkIndex,
                origin: "first_stage" as const,
                selectionReason: "exact_baseline_fallback",
                maxWordTrigramJaccard: 0,
            })),
            reranker: {
                requestedModel: RERANKER_MODEL,
                resolvedModel: null,
                promptVersion: RERANKER_PROMPT_VERSION,
                status,
                durationMs: rerankerDurationMs,
                usage: null,
                estimatedCost: null,
                fallbackReason,
            },
            diversity: { maxWordTrigramJaccard: 0 },
        },
    });

    if (broad.diagnostics.mode === "hybrid" && !baseline.length) {
        return makeFallback("skipped", "no_baseline_eligible_hybrid_seed");
    }
    if (!broad.results.length) return makeFallback("skipped", "no_candidates");

    let rerankerStartedAt: number | null = null;
    try {
        const chunks = await chunkReader.getCollectionChunks(collectionName);
        const candidates = expandRerankCandidates(broad.results, chunks);
        const boundedDocuments = buildBoundedRerankerDocuments(candidates);
        const activeReranker = reranker ?? new OpenAIChatReranker();
        rerankerStartedAt = Date.now();
        const reranked = await activeReranker.rerank({
            query,
            documents: boundedDocuments,
            topN: boundedDocuments.length,
            signal,
        });
        const scores = new Map(
            reranked.rankings.map((ranking) => [ranking.id, ranking.score])
        );
        const ranks = new Map(
            reranked.rankings.map((ranking) => [ranking.id, ranking.rank])
        );
        const results = selectWithDeterministicMmr(candidates, scores).map(
            (result) => ({
                ...result,
                rerankerRank: ranks.get(result.id) ?? result.rerankerRank,
            })
        );
        const finalCandidates = results.map((result, index) => {
            const source = candidates.find(
                (candidate) => candidate.id === result.id
            )!;
            const previous = results.slice(0, index);
            const maxSimilarity = previous.length
                ? Math.max(
                      ...previous.map((candidate) =>
                          wordTrigramJaccard(result.content, candidate.content)
                      )
                  )
                : 0;
            return {
                id: result.id,
                rank: index + 1,
                firstStageRank: source.firstStageRank,
                chunkIndex: result.chunkIndex,
                origin: source.origin,
                ...(source.neighborOf ? { neighborOf: source.neighborOf } : {}),
                rerankerRank: result.rerankerRank,
                rerankerScore: result.rerankerScore,
                selectionReason: result.selectionReason,
                maxWordTrigramJaccard: maxSimilarity,
            };
        });
        const maxSimilarity = finalCandidates.reduce(
            (maximum, candidate) =>
                Math.max(maximum, candidate.maxWordTrigramJaccard),
            0
        );
        const usage = normalizeModelUsage(reranked.usage);
        return {
            results,
            diagnostics: {
                mode: "reranked",
                durationMs: Date.now() - startedAt,
                firstStage,
                firstStageCandidates: diagnosticCandidates(candidates),
                finalCandidates,
                reranker: {
                    requestedModel: reranked.requestedModel,
                    resolvedModel: reranked.resolvedModel,
                    promptVersion: RERANKER_PROMPT_VERSION,
                    status: "success",
                    durationMs: reranked.durationMs,
                    usage,
                    estimatedCost: estimateModelCost(
                        reranked.resolvedModel,
                        usage
                    ),
                    fallbackReason: null,
                },
                diversity: { maxWordTrigramJaccard: maxSimilarity },
            },
        };
    } catch (error) {
        return makeFallback(
            "fallback",
            classifyRerankerFallback(error),
            rerankerStartedAt === null ? 0 : Date.now() - rerankerStartedAt
        );
    }
};
