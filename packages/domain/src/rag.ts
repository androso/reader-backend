import type {
    ChatModelCost,
    ChatModelUsage,
    ChatRagRetrievalDiagnostics,
    ChatSourceMetadata,
} from "./chat";

export type RagChunkMetadata = ChatSourceMetadata;

export interface RagChunk {
    id: string;
    collectionName: string;
    chunkIndex: number;
    content: string;
    metadata?: RagChunkMetadata | null;
}

export interface RagRankedResult {
    id: string;
    content: string;
    chunkIndex: number;
    score: number;
    bestRank: number;
    metadata?: RagChunkMetadata | null;
}

export interface RagLexicalResult {
    id: string;
    content: string;
    chunkIndex: number;
    rank: number;
    metadata?: RagChunkMetadata | null;
}

export interface RagVectorResult {
    id: string;
    content: string;
    rank: number;
    distance?: number;
}

export interface RagCandidate extends RagRankedResult {
    firstStageRank: number;
    origin: "first_stage" | "neighbor";
    neighborOf?: string;
}

export type RagRetrievalDiagnostics = ChatRagRetrievalDiagnostics;
export type RagModelUsage = ChatModelUsage;
export type RagModelCost = ChatModelCost;

export const RAG_PIPELINES = {
    "baseline-rag-v1": {
        pipelineVersion: "baseline-rag-v1",
        retrievalStrategy: "baseline",
        promptVersion: "book-context-v1",
        answerPromptVersion: "book-context-v1",
        rerankerPromptVersion: null,
        rerankerModel: null,
    },
    "rerank-rag-v1": {
        pipelineVersion: "rerank-rag-v1",
        retrievalStrategy: "reranked",
        promptVersion: "book-context-v1",
        answerPromptVersion: "book-context-v1",
        rerankerPromptVersion: "rerank-documents-v1",
        rerankerModel: "gpt-5.4-mini-2026-03-17",
    },
} as const;

export const RERANKER_MODELS = {
    "gpt-5.4-mini-2026-03-17": "gpt-5.4-mini-2026-03-17",
} as const;

export type RagPipelineVersion = keyof typeof RAG_PIPELINES;

export const DEFAULT_RAG_PIPELINE_VERSION: RagPipelineVersion =
    "baseline-rag-v1";

export type RerankerFailureCategory =
    | "timeout"
    | "refusal"
    | "invalid_or_incomplete_ranking"
    | "provider_error";

export interface RerankerFailure {
    category: RerankerFailureCategory;
    message: string;
}

export interface RagRerankerRanking {
    id: string;
    score: number;
    rank: number;
}

export interface RagRerankerResult {
    rankings: RagRerankerRanking[];
    requestedModel: string;
    resolvedModel: string;
    usage: Record<string, unknown> | null;
    durationMs: number;
}

export interface RagShadowSourceRank {
    id: string;
    rank: number;
}

export interface RagShadowResult {
    version: "rag-shadow-v1";
    completedAt: string;
    baseline: {
        pipelineVersion: string;
        sources: RagShadowSourceRank[];
        traceId: string | null;
    };
    candidate: {
        pipelineVersion: "rerank-rag-v1";
        sources: RagShadowSourceRank[];
        retrievalDurationMs: number;
        reranker: {
            requestedModel: string;
            resolvedModel: string | null;
            status: "success" | "skipped" | "fallback";
            durationMs: number;
            fallbackReason: string | null;
            usage: RagModelUsage | null;
            estimatedCost: RagModelCost | null;
        };
        maxWordTrigramJaccard: number;
        traceId: string | null;
    };
    comparison: {
        overlapCount: number;
        sourceSetJaccard: number;
        exactRankMatches: number;
        identical: boolean;
    };
}
