import {
    BASELINE_MIN_HYBRID_SCORE,
    RERANK_CANDIDATE_LIMIT,
    RERANK_FINAL_LIMIT,
    RERANK_FIRST_STAGE_LIMIT,
    RERANKER_MAX_DOCUMENT_CHARACTERS,
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
    type BookChunkReader,
    type Reranker,
} from "@reader/application";
import { ChatCancelledError } from "@reader/domain";
import type {
    BookSearchChunk,
    HybridBookSearchService,
    RankedSearchResult,
    RerankerProvider,
} from "@reader/providers";
import { bookSearchChunkStore } from "./BookSearchChunkStore";
import { hybridBookSearchService } from "./HybridBookSearchService";
import { createRetrieveBookEvidence } from "../infrastructure/rag/composition";
import type { RerankedRetrievalDiagnostics } from "../types/ragTelemetry";

export {
    BASELINE_MIN_HYBRID_SCORE,
    RERANK_CANDIDATE_LIMIT,
    RERANK_FINAL_LIMIT,
    RERANK_FIRST_STAGE_LIMIT,
    RERANKER_MAX_DOCUMENT_CHARACTERS,
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
};

export const retrieveRerankedEvidence = async ({
    collectionName,
    query,
    minHybridScore,
    signal,
    searchService = hybridBookSearchService,
    chunkReader = bookSearchChunkStore,
    reranker,
    strictInfrastructureErrors = false,
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
    strictInfrastructureErrors?: boolean;
}): Promise<{
    results: Array<RankedSearchResult | SelectedRerankedResult>;
    diagnostics: RerankedRetrievalDiagnostics;
}> => {
    if (signal?.aborted) throw signal.reason ?? new ChatCancelledError();
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
    if (signal?.aborted) throw signal.reason ?? new ChatCancelledError();
    const engine = createRetrieveBookEvidence(undefined, {
        chunks: chunkReader as unknown as BookChunkReader,
        ...(reranker ? { reranker: reranker as unknown as Reranker } : {}),
    });
    return engine.retrieveReranked({
        collectionName,
        query,
        minHybridScore,
        signal,
        strictInfrastructureErrors,
        startedAt,
        firstStage: {
            results: broad.results,
            diagnostics: broad.diagnostics,
        } as never,
    });
};
