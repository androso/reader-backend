import type { BookContextResult } from "@reader/api/rag";
import type {
    EvalThresholds,
    PreparedEvalCase,
    RagEvalCase,
    RetrievalCaseResult,
    RetrievalSummary,
} from "./types";

const mean = (values: number[]) =>
    values.length
        ? values.reduce((total, value) => total + value, 0) / values.length
        : 0;

export const resolveLiveEvalSources = (
    testCase: RagEvalCase,
    rag: BookContextResult
) => {
    if (
        rag.status !== "ready" ||
        (!testCase.noAnswerExpected && !rag.sources?.length)
    ) {
        throw new Error(
            `Reader did not produce RAG context for ${testCase.id}`
        );
    }

    return rag.sources ?? [];
};

const parseChunkIndex = (id: string) => {
    const parsed = Number(id.slice(id.lastIndexOf("_") + 1));
    return Number.isFinite(parsed) ? parsed : null;
};

const scoreCase = (testCase: PreparedEvalCase): RetrievalCaseResult => {
    const resultIds = testCase.sources.map((source) => source.id);
    const noAnswerExpected = Boolean(testCase.noAnswerExpected);
    const expectedRank = testCase.expectedChunkId
        ? resultIds.indexOf(testCase.expectedChunkId) + 1
        : 0;
    const sourceHit = !noAnswerExpected && expectedRank > 0;
    const vectorExpectedRank = testCase.expectedChunkId
        ? testCase.vectorResultIds.indexOf(testCase.expectedChunkId) + 1
        : 0;
    const vectorSourceHit = !noAnswerExpected && vectorExpectedRank > 0;
    const vectorReciprocalRank =
        vectorExpectedRank > 0 ? 1 / vectorExpectedRank : 0;
    const recallAtK = sourceHit ? 1 : 0;
    const reciprocalRank = expectedRank > 0 ? 1 / expectedRank : 0;
    const expectedChunkIndex = testCase.expectedChunkId
        ? parseChunkIndex(testCase.expectedChunkId)
        : null;
    const chunkWindowHit = noAnswerExpected
        ? false
        : expectedChunkIndex !== null &&
          testCase.sources.some(
              (source) => Math.abs(source.chunkIndex - expectedChunkIndex) <= 1
          );
    const chapterCorrect = testCase.expectedChapterTitle
        ? testCase.sources.some(
              (source) =>
                  source.metadata?.chapterTitle ===
                  testCase.expectedChapterTitle
          )
        : null;
    const passed = noAnswerExpected
        ? testCase.vectorIdsAligned && testCase.sources.length === 0
        : sourceHit &&
          vectorSourceHit &&
          testCase.vectorIdsAligned &&
          chunkWindowHit &&
          chapterCorrect !== false;

    return {
        id: testCase.id,
        question: testCase.question,
        results: testCase.sources,
        expectedChunkId: testCase.expectedChunkId,
        expectedChapterTitle: testCase.expectedChapterTitle,
        noAnswerExpected,
        recallAtK,
        reciprocalRank,
        sourceHit,
        vectorSourceHit,
        vectorReciprocalRank,
        vectorIdsAligned: testCase.vectorIdsAligned,
        chunkWindowHit,
        chapterCorrect,
        passed,
    };
};

export const scoreRetrievalEval = (
    cases: PreparedEvalCase[],
    thresholds: EvalThresholds
) => {
    const caseResults = cases.map(scoreCase);
    const answerableCases = caseResults.filter(
        (result) => !result.noAnswerExpected
    );
    const chapterCases = answerableCases.filter(
        (result) => result.chapterCorrect !== null
    );

    const summary: RetrievalSummary = {
        caseCount: caseResults.length,
        recallAtK: mean(answerableCases.map((result) => result.recallAtK)),
        mrr: mean(answerableCases.map((result) => result.reciprocalRank)),
        sourceHitRate: mean(
            answerableCases.map((result) => (result.sourceHit ? 1 : 0))
        ),
        vectorSourceHitRate: mean(
            answerableCases.map((result) => (result.vectorSourceHit ? 1 : 0))
        ),
        vectorMrr: mean(
            answerableCases.map((result) => result.vectorReciprocalRank)
        ),
        vectorIdAlignmentRate: mean(
            caseResults.map((result) => (result.vectorIdsAligned ? 1 : 0))
        ),
        chunkWindowHitRate: mean(
            answerableCases.map((result) => (result.chunkWindowHit ? 1 : 0))
        ),
        chapterAccuracy: chapterCases.length
            ? mean(
                  chapterCases.map((result) => (result.chapterCorrect ? 1 : 0))
              )
            : null,
        passed: false,
    };
    summary.passed =
        summary.recallAtK >= thresholds.minRecallAtK &&
        summary.mrr >= thresholds.minMrr &&
        summary.sourceHitRate >= thresholds.minSourceHitRate &&
        summary.vectorSourceHitRate >= thresholds.minSourceHitRate &&
        summary.vectorIdAlignmentRate === 1 &&
        summary.chunkWindowHitRate >= thresholds.minChunkWindowHitRate &&
        caseResults.every((result) => result.passed);

    return { summary, cases: caseResults };
};
