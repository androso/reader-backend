import type {
    BookSearchChunk,
    BookSearchChunkMetadata,
    RankedSearchResult,
} from "@reader/providers";

export interface RagEvalCase {
    id: string;
    question: string;
    collectionName: string;
    chunks: BookSearchChunk[];
    vectorResults?: Array<{
        id: string;
        content: string;
        rank: number;
        distance?: number;
    }>;
    expectedChunkIds: string[];
    expectedCitationChunkIds?: string[];
    expectedAnswer?: string;
    candidateAnswer?: string;
    noAnswerExpected?: boolean;
    expectedChapterTitle?: string;
    expectedPageNumber?: number;
    sourceTraceId?: string;
}

export interface RetrievalCaseResult {
    id: string;
    question: string;
    results: RankedSearchResult[];
    expectedChunkIds: string[];
    noAnswerExpected: boolean;
    recallAtK: number;
    reciprocalRank: number;
    sourceHit: boolean;
    noAnswerCorrect: boolean;
    chunkWindowHit: boolean;
    chapterCorrect: boolean | null;
    pageCorrect: boolean | null;
    passed: boolean;
}

export interface JudgeScores {
    groundedness: number;
    citationCoverage: number;
    refusalCorrectness: number;
    hallucinationRate: number;
    rationale: string;
}

export interface AnswerCaseResult {
    id: string;
    question: string;
    answer: string;
    expectedAnswer?: string;
    scores: JudgeScores;
    passed: boolean;
}

export interface EvalThresholds {
    minRecallAtK: number;
    minMrr: number;
    minSourceHitRate: number;
    minNoAnswerAccuracy: number;
    minChunkWindowHitRate: number;
    minGroundedness: number;
    minCitationCoverage: number;
    maxHallucinationRate: number;
}

export interface RetrievalSummary {
    caseCount: number;
    recallAtK: number;
    mrr: number;
    sourceHitRate: number;
    noAnswerAccuracy: number;
    chunkWindowHitRate: number;
    chapterAccuracy: number | null;
    pageAccuracy: number | null;
    passed: boolean;
}

export interface AnswerSummary {
    caseCount: number;
    groundedness: number;
    citationCoverage: number;
    refusalCorrectness: number;
    hallucinationRate: number;
    passed: boolean;
}

export interface RagEvalReport {
    runId: string;
    createdAt: string;
    judgeModel: string;
    thresholds: EvalThresholds;
    retrieval?: {
        summary: RetrievalSummary;
        cases: RetrievalCaseResult[];
    };
    answers?: {
        summary: AnswerSummary;
        cases: AnswerCaseResult[];
    };
}

export type ChunkMetadata = BookSearchChunkMetadata;
