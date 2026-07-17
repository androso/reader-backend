import type { BookContextResult } from "@reader/api/rag";
import type {
    EvalCategory,
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
    const evidenceHits = testCase.expectedChunkIds.filter((id) =>
        resultIds.includes(id)
    ).length;
    const evidenceCoverage = noAnswerExpected
        ? 1
        : testCase.expectedChunkIds.length
          ? evidenceHits / testCase.expectedChunkIds.length
          : 0;
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
    const expectedChapterTitles = [
        ...new Set(
            (testCase.expectedEvidence ?? [])
                .map((anchor) => anchor.chapterTitle)
                .filter((value): value is string => Boolean(value))
        ),
    ];
    const chapterCorrect = expectedChapterTitles.length
        ? expectedChapterTitles.every((chapterTitle) =>
              testCase.sources.some(
                  (source) => source.metadata?.chapterTitle === chapterTitle
              )
          )
        : null;
    const passed = noAnswerExpected
        ? testCase.vectorIdsAligned && testCase.sources.length === 0
        : sourceHit &&
          evidenceCoverage === 1 &&
          vectorSourceHit &&
          testCase.vectorIdsAligned &&
          chunkWindowHit &&
          chapterCorrect !== false;

    return {
        id: testCase.id,
        fixtureId: testCase.fixtureId,
        suite: testCase.suite,
        category: testCase.category,
        question: testCase.question,
        results: testCase.sources,
        expectedChunkId: testCase.expectedChunkId,
        expectedChunkIds: testCase.expectedChunkIds,
        noAnswerExpected,
        recallAtK,
        evidenceCoverage,
        reciprocalRank,
        sourceHit,
        vectorSourceHit,
        vectorReciprocalRank,
        vectorIdsAligned: testCase.vectorIdsAligned,
        chunkWindowHit,
        chapterCorrect,
        pipelineVersion: testCase.pipelineVersion,
        promptVersion: testCase.promptVersion,
        retrievalDurationMs: testCase.retrievalDurationMs,
        passed,
    };
};

const categorySlices = (
    caseResults: RetrievalCaseResult[]
): RetrievalSummary["perCategory"] => {
    const categories = [
        ...new Set(caseResults.map((result) => result.category)),
    ] as EvalCategory[];
    return Object.fromEntries(
        categories.map((category) => {
            const cases = caseResults.filter(
                (result) => result.category === category
            );
            const answerable = cases.filter(
                (result) => !result.noAnswerExpected
            );
            return [
                category,
                {
                    caseCount: cases.length,
                    recallAtK: answerable.length
                        ? mean(answerable.map((result) => result.recallAtK))
                        : 1,
                    evidenceCoverage: answerable.length
                        ? mean(
                              answerable.map(
                                  (result) => result.evidenceCoverage
                              )
                          )
                        : 1,
                    sourceHitRate: answerable.length
                        ? mean(
                              answerable.map((result) =>
                                  result.sourceHit ? 1 : 0
                              )
                          )
                        : 1,
                    passed: cases.every((result) => result.passed),
                },
            ];
        })
    );
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
        evidenceCoverage: mean(
            answerableCases.map((result) => result.evidenceCoverage)
        ),
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
        perCategory: categorySlices(caseResults),
        passed: false,
    };
    summary.passed =
        summary.recallAtK >= thresholds.minRecallAtK &&
        summary.evidenceCoverage >= thresholds.minRecallAtK &&
        summary.mrr >= thresholds.minMrr &&
        summary.sourceHitRate >= thresholds.minSourceHitRate &&
        summary.vectorSourceHitRate >= thresholds.minSourceHitRate &&
        summary.vectorIdAlignmentRate === 1 &&
        summary.chunkWindowHitRate >= thresholds.minChunkWindowHitRate &&
        caseResults.every((result) => result.passed);

    return { summary, cases: caseResults };
};
