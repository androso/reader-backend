import type {
    EstimatedModelCost,
    NormalizedModelUsage,
} from "@reader/api/ai-usage";
import type {
    ChatMessage,
    HighlightContext,
    MessageContextSource,
} from "@reader/api/rag";

export type EvalSuite = "required" | "extended";
export type EvalCategory =
    | "factual"
    | "paraphrase"
    | "no_answer"
    | "follow_up"
    | "highlight"
    | "summary"
    | "comparison"
    | "adversarial"
    | "isolation";

export interface ExpectedEvidenceAnchor {
    text: string;
    chapterTitle?: string;
}

export interface RagEvalCase {
    id: string;
    fixtureId: string;
    suite: EvalSuite;
    category: EvalCategory;
    question: string;
    expectedAnswer: string;
    expectedEvidence?: ExpectedEvidenceAnchor[];
    noAnswerExpected?: boolean;
    priorMessages?: ChatMessage[];
    highlightContext?: HighlightContext;
}

export interface PreparedEvalCase extends RagEvalCase {
    answerModel: string;
    resolvedAnswerModel: string;
    expectedChunkId?: string;
    expectedChunkIds: string[];
    candidateAnswer: string;
    sources: MessageContextSource[];
    vectorResultIds: string[];
    vectorIdsAligned: boolean;
    pipelineVersion: string;
    promptVersion: string;
    retrievalDurationMs: number;
    generationDurationMs: number;
    answerUsage: NormalizedModelUsage | null;
    answerEstimatedCost: EstimatedModelCost | null;
}

export interface RetrievalCaseResult {
    id: string;
    fixtureId: string;
    suite: EvalSuite;
    category: EvalCategory;
    question: string;
    results: MessageContextSource[];
    expectedChunkId?: string;
    expectedChunkIds: string[];
    noAnswerExpected: boolean;
    recallAtK: number;
    evidenceCoverage: number;
    reciprocalRank: number;
    sourceHit: boolean;
    vectorSourceHit: boolean;
    vectorReciprocalRank: number;
    vectorIdsAligned: boolean;
    chunkWindowHit: boolean;
    chapterCorrect: boolean | null;
    pipelineVersion: string;
    promptVersion: string;
    retrievalDurationMs: number;
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
    fixtureId: string;
    suite: EvalSuite;
    category: EvalCategory;
    question: string;
    answer: string;
    expectedAnswer: string;
    answerModel: string;
    resolvedAnswerModel: string;
    judgeModel: string;
    resolvedJudgeModel: string;
    scores: JudgeScores;
    generationDurationMs: number;
    judgeDurationMs: number;
    answerUsage: NormalizedModelUsage | null;
    judgeUsage: NormalizedModelUsage | null;
    answerEstimatedCost: EstimatedModelCost | null;
    judgeEstimatedCost: EstimatedModelCost | null;
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
    evidenceCoverage: number;
    mrr: number;
    sourceHitRate: number;
    vectorSourceHitRate: number;
    vectorMrr: number;
    vectorIdAlignmentRate: number;
    chunkWindowHitRate: number;
    chapterAccuracy: number | null;
    perCategory: Partial<
        Record<
            EvalCategory,
            {
                caseCount: number;
                recallAtK: number;
                evidenceCoverage: number;
                sourceHitRate: number;
                passed: boolean;
            }
        >
    >;
    passed: boolean;
}

export interface AnswerSummary {
    caseCount: number;
    groundedness: number;
    citationCoverage: number;
    refusalCorrectness: number;
    hallucinationRate: number;
    perCategory: Partial<
        Record<
            EvalCategory,
            {
                caseCount: number;
                groundedness: number;
                citationCoverage: number;
                refusalCorrectness: number;
                hallucinationRate: number;
                passed: boolean;
            }
        >
    >;
    passed: boolean;
}

export interface RagEvalFixture {
    id: string;
    fileName: string;
    title: string;
    author: string;
    downloadUrl: string;
    sourceRepository: string;
    sourceRevision: string;
    sha256: string;
    sizeBytes: number;
}

export interface RagEvalIngestion {
    fixtureId: string;
    bookId: string;
    collectionName: string;
    extractedChunkCount: number;
    storedChunkCount: number;
}

export interface RagEvalReport {
    runId: string;
    createdAt: string;
    suite: EvalSuite;
    qualityPassed: boolean;
    answerModels: string[];
    resolvedAnswerModels: string[];
    judgeModel: string;
    resolvedJudgeModels: string[];
    execution: {
        pipelineVersions: string[];
        promptVersions: string[];
        pricingVersion: string;
        latencyMs: {
            retrieval: number;
            generation: number;
            judge: number;
            total: number;
        };
        usage: {
            answers: NormalizedModelUsage | null;
            judge: NormalizedModelUsage | null;
        };
        estimatedCostUsd: {
            answers: number | null;
            judge: number | null;
            total: number | null;
            embeddingIncluded: false;
        };
    };
    thresholds: EvalThresholds;
    fixtures: RagEvalFixture[];
    ingestion: RagEvalIngestion[];
    retrieval: {
        summary: RetrievalSummary;
        cases: RetrievalCaseResult[];
    };
    answers: {
        summary: AnswerSummary;
        cases: AnswerCaseResult[];
    };
}
