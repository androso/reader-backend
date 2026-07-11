import type { MessageContextSource } from "@reader/api/rag";

export interface RagEvalCase {
    id: string;
    question: string;
    expectedAnswer: string;
    expectedEvidenceText?: string;
    expectedChapterTitle?: string;
    noAnswerExpected?: boolean;
}

export interface PreparedEvalCase extends RagEvalCase {
    answerModel: string;
    expectedChunkId?: string;
    candidateAnswer: string;
    sources: MessageContextSource[];
    vectorResultIds: string[];
    vectorIdsAligned: boolean;
}

export interface RetrievalCaseResult {
    id: string;
    question: string;
    results: MessageContextSource[];
    expectedChunkId?: string;
    expectedChapterTitle?: string;
    noAnswerExpected: boolean;
    recallAtK: number;
    reciprocalRank: number;
    sourceHit: boolean;
    vectorSourceHit: boolean;
    vectorReciprocalRank: number;
    vectorIdsAligned: boolean;
    chunkWindowHit: boolean;
    chapterCorrect: boolean | null;
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
    expectedAnswer: string;
    answerModel: string;
    scores: JudgeScores;
    passed: boolean;
}

export interface EvalThresholds {
    minRecallAtK: number;
    minMrr: number;
    minSourceHitRate: number;
    minChunkWindowHitRate: number;
    minGroundedness: number;
    minCitationCoverage: number;
    minRefusalCorrectness: number;
    maxHallucinationRate: number;
}

export interface RetrievalSummary {
    caseCount: number;
    recallAtK: number;
    mrr: number;
    sourceHitRate: number;
    vectorSourceHitRate: number;
    vectorMrr: number;
    vectorIdAlignmentRate: number;
    chunkWindowHitRate: number;
    chapterAccuracy: number | null;
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

export interface RagEvalFixture {
    title: string;
    author: string;
    sourceUrl: string;
    sourceRevision: string;
    sha256: string;
    sizeBytes: number;
}

export interface RagEvalIngestion {
    collectionName: string;
    extractedChunkCount: number;
    storedChunkCount: number;
}

export interface RagEvalReport {
    runId: string;
    createdAt: string;
    answerModels: string[];
    judgeModel: string;
    thresholds: EvalThresholds;
    fixture: RagEvalFixture;
    ingestion: RagEvalIngestion;
    retrieval: {
        summary: RetrievalSummary;
        cases: RetrievalCaseResult[];
    };
    answers: {
        summary: AnswerSummary;
        cases: AnswerCaseResult[];
    };
}
