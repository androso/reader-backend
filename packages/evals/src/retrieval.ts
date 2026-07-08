import {
    HybridBookSearchService,
    type BookSearchChunk,
    type VectorSearchResult,
} from "@reader/providers";
import type {
    EvalThresholds,
    RagEvalCase,
    RetrievalCaseResult,
    RetrievalSummary,
} from "./types";

const mean = (values: number[]) =>
    values.length
        ? values.reduce((total, value) => total + value, 0) / values.length
        : 0;

const getExpectedRank = (resultIds: string[], expectedIds: string[]) => {
    const index = resultIds.findIndex((id) => expectedIds.includes(id));
    return index === -1 ? null : index + 1;
};

const hasChunkWindowHit = (
    resultIds: string[],
    expectedIds: string[],
    chunks: BookSearchChunk[]
) => {
    if (!expectedIds.length) return true;
    const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const expectedIndexes = expectedIds
        .map((id) => chunkById.get(id)?.chunkIndex)
        .filter((value): value is number => typeof value === "number");
    const retrievedIndexes = resultIds
        .map((id) => chunkById.get(id)?.chunkIndex)
        .filter((value): value is number => typeof value === "number");

    return expectedIndexes.some((expected) =>
        retrievedIndexes.some((retrieved) => Math.abs(retrieved - expected) <= 1)
    );
};

const runCase = async (testCase: RagEvalCase): Promise<RetrievalCaseResult> => {
    const service = new HybridBookSearchService(
        {
            getCollectionChunks: async () => testCase.chunks,
        },
        {
            searchDocuments: async () =>
                (testCase.vectorResults ?? []) as VectorSearchResult[],
        }
    );

    const results = await service.search(
        testCase.collectionName,
        testCase.question,
        { finalLimit: 5 }
    );
    const resultIds = results.map((result) => result.id);
    const noAnswerExpected = Boolean(testCase.noAnswerExpected);
    const expectedIds = testCase.expectedChunkIds;
    const expectedRank = getExpectedRank(resultIds, expectedIds);
    const recallAtK = expectedIds.length
        ? expectedIds.filter((id) => resultIds.includes(id)).length /
          expectedIds.length
        : results.length === 0
          ? 1
          : 0;
    const reciprocalRank = expectedRank ? 1 / expectedRank : 0;
    const sourceHit = expectedIds.length
        ? expectedIds.some((id) => resultIds.includes(id))
        : results.length === 0;
    const noAnswerCorrect = noAnswerExpected ? results.length === 0 : true;
    const chunkWindowHit = hasChunkWindowHit(resultIds, expectedIds, testCase.chunks);
    const chapterCorrect = testCase.expectedChapterTitle
        ? results.some(
              (result) =>
                  result.metadata?.chapterTitle === testCase.expectedChapterTitle
          )
        : null;
    const pageCorrect = testCase.expectedPageNumber
        ? results.some(
              (result) =>
                  result.metadata?.pageNumber === testCase.expectedPageNumber
          )
        : null;
    const passed =
        recallAtK > 0 &&
        sourceHit &&
        noAnswerCorrect &&
        chunkWindowHit &&
        chapterCorrect !== false &&
        pageCorrect !== false;

    return {
        id: testCase.id,
        question: testCase.question,
        results,
        expectedChunkIds: expectedIds,
        noAnswerExpected,
        recallAtK,
        reciprocalRank,
        sourceHit,
        noAnswerCorrect,
        chunkWindowHit,
        chapterCorrect,
        pageCorrect,
        passed,
    };
};

export const runRetrievalEval = async (
    cases: RagEvalCase[],
    thresholds: EvalThresholds
) => {
    const caseResults = await Promise.all(cases.map(runCase));
    const noAnswerCases = caseResults.filter((result) => result.noAnswerExpected);
    const chapterCases = caseResults.filter(
        (result) => result.chapterCorrect !== null
    );
    const pageCases = caseResults.filter((result) => result.pageCorrect !== null);

    const summary: RetrievalSummary = {
        caseCount: caseResults.length,
        recallAtK: mean(caseResults.map((result) => result.recallAtK)),
        mrr: mean(caseResults.map((result) => result.reciprocalRank)),
        sourceHitRate: mean(caseResults.map((result) => (result.sourceHit ? 1 : 0))),
        noAnswerAccuracy: noAnswerCases.length
            ? mean(noAnswerCases.map((result) => (result.noAnswerCorrect ? 1 : 0)))
            : 1,
        chunkWindowHitRate: mean(
            caseResults.map((result) => (result.chunkWindowHit ? 1 : 0))
        ),
        chapterAccuracy: chapterCases.length
            ? mean(chapterCases.map((result) => (result.chapterCorrect ? 1 : 0)))
            : null,
        pageAccuracy: pageCases.length
            ? mean(pageCases.map((result) => (result.pageCorrect ? 1 : 0)))
            : null,
        passed: false,
    };
    summary.passed =
        summary.recallAtK >= thresholds.minRecallAtK &&
        summary.mrr >= thresholds.minMrr &&
        summary.sourceHitRate >= thresholds.minSourceHitRate &&
        summary.noAnswerAccuracy >= thresholds.minNoAnswerAccuracy &&
        summary.chunkWindowHitRate >= thresholds.minChunkWindowHitRate &&
        caseResults.every((result) => result.passed);

    return { summary, cases: caseResults };
};
