import type {
    ChatHybridSearchDiagnostics,
    RagChunk,
    RagLexicalResult,
    RagRankedResult,
    RagVectorResult,
} from "@reader/domain";

export const RRF_K = 60;

export type HydratedVectorResult = RagVectorResult & {
    chunkIndex?: number;
    metadata?: RagChunk["metadata"];
};

export const parseChunkIndex = (id: string) => {
    const maybeIndex = Number(id.slice(id.lastIndexOf("_") + 1));
    return Number.isFinite(maybeIndex) ? maybeIndex : Number.MAX_SAFE_INTEGER;
};

export const hydrateVectorResults = (
    results: RagVectorResult[],
    chunks: RagChunk[]
): HydratedVectorResult[] => {
    const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    return results.map((result) => {
        const chunk = chunksById.get(result.id);
        return {
            ...result,
            content: result.content || chunk?.content || "",
            chunkIndex: chunk?.chunkIndex,
            metadata: chunk?.metadata,
        };
    });
};

export const createVectorOnlyResults = (
    results: HydratedVectorResult[],
    limit: number
): RagRankedResult[] =>
    results.slice(0, limit).map((result) => ({
        id: result.id,
        content: result.content,
        chunkIndex: result.chunkIndex ?? parseChunkIndex(result.id),
        score: 1 / (RRF_K + result.rank),
        bestRank: result.rank,
        metadata: result.metadata,
    }));

export const fuseHybridResults = (
    lexicalResults: RagLexicalResult[],
    vectorResults: HydratedVectorResult[],
    limit: number
): RagRankedResult[] => {
    const fused = new Map<string, RagRankedResult>();

    const addResult = (
        result: {
            id: string;
            content: string;
            rank: number;
            chunkIndex?: number;
            metadata?: RagChunk["metadata"];
        },
        rank: number
    ) => {
        const existing = fused.get(result.id);
        const score = 1 / (RRF_K + rank);
        if (existing) {
            existing.score += score;
            existing.bestRank = Math.min(existing.bestRank, rank);
            if (!existing.content && result.content) {
                existing.content = result.content;
            }
            if (!existing.metadata && result.metadata) {
                existing.metadata = result.metadata;
            }
            return;
        }

        fused.set(result.id, {
            id: result.id,
            content: result.content,
            chunkIndex: result.chunkIndex ?? parseChunkIndex(result.id),
            score,
            bestRank: rank,
            metadata: result.metadata,
        });
    };

    lexicalResults.forEach((result) => addResult(result, result.rank));
    vectorResults.forEach((result) => addResult(result, result.rank));

    return Array.from(fused.values())
        .filter((result) => result.content)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
            return a.chunkIndex - b.chunkIndex;
        })
        .slice(0, limit);
};

export const deriveHybridSearchResponse = (
    lexicalResults: RagLexicalResult[],
    vectorResults: RagVectorResult[],
    hydratedVectorResults: HydratedVectorResult[],
    {
        finalLimit,
        minScore,
        durationMs,
    }: { finalLimit: number; minScore: number; durationMs: number }
): { results: RagRankedResult[]; diagnostics: ChatHybridSearchDiagnostics } => {
    if (!lexicalResults.length) {
        const results = createVectorOnlyResults(
            hydratedVectorResults,
            finalLimit
        );
        return {
            results,
            diagnostics: {
                mode: "vector_only",
                durationMs,
                lexicalCandidates: [],
                vectorCandidates: vectorResults.map((result) => ({
                    id: result.id,
                    rank: result.rank,
                    distance: result.distance,
                })),
                selectedCandidates: results.map((result, index) => ({
                    id: result.id,
                    rank: index + 1,
                    score: result.score,
                })),
            },
        };
    }

    const results = fuseHybridResults(
        lexicalResults,
        hydratedVectorResults,
        finalLimit
    ).filter((result) => result.score >= minScore);
    return {
        results,
        diagnostics: {
            mode: "hybrid",
            durationMs,
            lexicalCandidates: lexicalResults.map((result) => ({
                id: result.id,
                rank: result.rank,
            })),
            vectorCandidates: vectorResults.map((result) => ({
                id: result.id,
                rank: result.rank,
                distance: result.distance,
            })),
            selectedCandidates: results.map((result, index) => ({
                id: result.id,
                rank: index + 1,
                score: result.score,
            })),
        },
    };
};
