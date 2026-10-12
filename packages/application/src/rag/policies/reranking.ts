import type {
    RagCandidate,
    RagChunk,
    RagRankedResult,
    RerankerFailureCategory,
} from "@reader/domain";
import type { ChatHybridSearchDiagnostics } from "@reader/domain";

export const RERANK_FIRST_STAGE_LIMIT = 20;
export const RERANK_FINAL_LIMIT = 5;
export const RERANK_CANDIDATE_LIMIT = 30;
export const BASELINE_MIN_HYBRID_SCORE = 0.03;
export const MMR_RELEVANCE_WEIGHT = 0.8;
export const MMR_DIVERSITY_WEIGHT = 0.2;
export const RERANKER_MAX_DOCUMENT_CHARACTERS = 40_000;

export type Candidate = RagCandidate;

export type SelectedRerankedResult = RagRankedResult & {
    rerankerRank: number;
    rerankerScore: number;
    selectionReason: string;
};

const isSameChapter = (left: RagChunk, right: RagRankedResult) => {
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

const isSamePage = (left: RagChunk, right: RagRankedResult) =>
    left.metadata?.pageNumber !== undefined &&
    left.metadata.pageNumber === right.metadata?.pageNumber;

export const deriveBaselineResults = (
    broadResults: RagRankedResult[],
    mode: ChatHybridSearchDiagnostics["mode"],
    minHybridScore: number
) =>
    (mode === "hybrid"
        ? broadResults.filter((result) => result.score >= minHybridScore)
        : broadResults
    ).slice(0, RERANK_FINAL_LIMIT);

export const expandRerankCandidates = (
    firstStage: RagRankedResult[],
    chunks: RagChunk[]
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

const isRerankerFailureCategory = (
    category: unknown
): category is RerankerFailureCategory =>
    category === "timeout" ||
    category === "refusal" ||
    category === "invalid_or_incomplete_ranking" ||
    category === "provider_error";

export const classifyRerankerFallback = (
    error: unknown
): RerankerFailureCategory => {
    if (
        error &&
        typeof error === "object" &&
        "category" in error &&
        isRerankerFailureCategory(error.category)
    ) {
        return error.category;
    }
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
        detail.includes("response incomplete") ||
        detail.includes("schema") ||
        detail.includes("ranking") ||
        detail.includes("candidate exactly once")
    ) {
        return "invalid_or_incomplete_ranking";
    }
    return "provider_error";
};

const SAFE_RERANKER_ERROR_PREFIXES = [
    "Reranker returned",
    "Reranker response",
    "Reranker ranking",
    "Reranker refused",
    "Reranker requires",
    "Reranker documents exceed",
    "Reranker candidate IDs",
    "Reranker topN",
] as const;

export const describeRerankerError = (error: unknown) => {
    const record =
        error && typeof error === "object"
            ? (error as Record<string, unknown>)
            : undefined;
    const message = error instanceof Error ? error.message : "";
    const safeDetail = SAFE_RERANKER_ERROR_PREFIXES.some((prefix) =>
        message.startsWith(prefix)
    )
        ? message
        : null;
    const stringField = (field: string) =>
        typeof record?.[field] === "string" ? record[field] : null;
    const numericField = (field: string) =>
        typeof record?.[field] === "number" ? record[field] : null;

    return {
        errorName: error instanceof Error ? error.name : typeof error,
        errorDetail: safeDetail,
        providerStatus: numericField("status"),
        providerCode: stringField("code"),
        providerType: stringField("type"),
        providerRequestId:
            stringField("request_id") ?? stringField("requestId"),
    };
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

export const maxWordTrigramSimilarity = (
    results: Array<Pick<RagRankedResult, "content">>
) => {
    let maximum = 0;
    for (let left = 0; left < results.length; left += 1) {
        for (let right = left + 1; right < results.length; right += 1) {
            maximum = Math.max(
                maximum,
                wordTrigramJaccard(
                    results[left].content,
                    results[right].content
                )
            );
        }
    }
    return maximum;
};

export const selectWithDeterministicMmr = (
    candidates: Candidate[],
    scores: Map<string, number>,
    limit = RERANK_FINAL_LIMIT,
    maxAllowedSimilarity = 1
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
            .filter(
                ({ maxSimilarity }) =>
                    maxSimilarity <= maxAllowedSimilarity + Number.EPSILON
            )
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
        if (!winner) break;
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

export const selectDiversityGuardedMmr = (
    candidates: Candidate[],
    scores: Map<string, number>,
    maxAllowedSimilarity: number,
    limit = RERANK_FINAL_LIMIT
) => {
    const targetResultCount = Math.min(limit, candidates.length);
    if (!targetResultCount) return [];

    let best:
        | {
              candidates: Candidate[];
              maxSimilarity: number;
              relevance: number;
              stableRanks: number[];
          }
        | undefined;
    const selected: Candidate[] = [];
    const similarityByPair = new Map<string, number>();
    const pairKey = (left: Candidate, right: Candidate) =>
        left.id < right.id
            ? `${left.id}\u0000${right.id}`
            : `${right.id}\u0000${left.id}`;
    for (let left = 0; left < candidates.length; left += 1) {
        for (let right = left + 1; right < candidates.length; right += 1) {
            similarityByPair.set(
                pairKey(candidates[left], candidates[right]),
                wordTrigramJaccard(
                    candidates[left].content,
                    candidates[right].content
                )
            );
        }
    }

    const selectedMaxSimilarity = () => {
        let maximum = 0;
        for (let left = 0; left < selected.length; left += 1) {
            for (let right = left + 1; right < selected.length; right += 1) {
                maximum = Math.max(
                    maximum,
                    similarityByPair.get(
                        pairKey(selected[left], selected[right])
                    ) ?? 0
                );
            }
        }
        return maximum;
    };

    const isBetter = (candidate: NonNullable<typeof best>) => {
        if (!best) return true;
        const candidateWithinCeiling =
            candidate.maxSimilarity <= maxAllowedSimilarity + Number.EPSILON;
        const bestWithinCeiling =
            best.maxSimilarity <= maxAllowedSimilarity + Number.EPSILON;
        if (candidateWithinCeiling !== bestWithinCeiling) {
            return candidateWithinCeiling;
        }
        if (
            !candidateWithinCeiling &&
            candidate.maxSimilarity !== best.maxSimilarity
        ) {
            return candidate.maxSimilarity < best.maxSimilarity;
        }
        if (candidate.relevance !== best.relevance) {
            return candidate.relevance > best.relevance;
        }
        for (let index = 0; index < candidate.stableRanks.length; index += 1) {
            if (candidate.stableRanks[index] !== best.stableRanks[index]) {
                return candidate.stableRanks[index] < best.stableRanks[index];
            }
        }
        return false;
    };

    const considerSelection = () => {
        const stableCandidates = [...selected].sort((left, right) => {
            if (left.firstStageRank !== right.firstStageRank) {
                return left.firstStageRank - right.firstStageRank;
            }
            return left.chunkIndex - right.chunkIndex;
        });
        const candidate = {
            candidates: [...selected],
            maxSimilarity: selectedMaxSimilarity(),
            relevance: selected.reduce(
                (total, result) => total + (scores.get(result.id) ?? 0),
                0
            ),
            stableRanks: stableCandidates.flatMap((result) => [
                result.firstStageRank,
                result.chunkIndex,
            ]),
        };
        if (isBetter(candidate)) best = candidate;
    };

    const visit = (startIndex: number) => {
        if (selected.length === targetResultCount) {
            considerSelection();
            return;
        }
        const remainingNeeded = targetResultCount - selected.length;
        for (
            let index = startIndex;
            index <= candidates.length - remainingNeeded;
            index += 1
        ) {
            selected.push(candidates[index]);
            visit(index + 1);
            selected.pop();
        }
    };

    visit(0);
    return selectWithDeterministicMmr(
        best?.candidates ?? candidates,
        scores,
        targetResultCount
    );
};

export const diagnosticCandidates = (candidates: Candidate[]) =>
    candidates.map((candidate) => ({
        id: candidate.id,
        firstStageRank: candidate.firstStageRank,
        chunkIndex: candidate.chunkIndex,
        origin: candidate.origin,
        ...(candidate.neighborOf ? { neighborOf: candidate.neighborOf } : {}),
    }));

export const baselineDiagnostics = (
    diagnostics: ChatHybridSearchDiagnostics,
    baseline: RagRankedResult[]
): ChatHybridSearchDiagnostics => ({
    ...diagnostics,
    selectedCandidates: baseline.map((result, index) => ({
        id: result.id,
        rank: index + 1,
        score: result.score,
    })),
});
