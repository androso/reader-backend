import type { RagShadowSourceRank } from "@reader/domain";

export const compareShadowSourceRanks = (
    baseline: RagShadowSourceRank[],
    candidate: RagShadowSourceRank[]
) => {
    const baselineIds = new Set(baseline.map((source) => source.id));
    const candidateIds = new Set(candidate.map((source) => source.id));
    let overlapCount = 0;
    for (const id of baselineIds) {
        if (candidateIds.has(id)) overlapCount += 1;
    }
    const unionSize = new Set([...baselineIds, ...candidateIds]).size;
    const exactRankMatches = baseline.filter(
        (source, index) => candidate[index]?.id === source.id
    ).length;
    return {
        overlapCount,
        sourceSetJaccard: unionSize === 0 ? 1 : overlapCount / unionSize,
        exactRankMatches,
        identical:
            baseline.length === candidate.length &&
            exactRankMatches === baseline.length,
    };
};
