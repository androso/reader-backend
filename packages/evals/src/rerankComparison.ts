import fs from "node:fs/promises";
import path from "node:path";
import { wordTrigramJaccard } from "@reader/api/rag";
import type {
    AnswerCaseResult,
    AnswerSummary,
    PreparedEvalCase,
    RagEvalCase,
    RagEvalFixture,
    RagEvalIngestion,
    RetrievalCaseResult,
    RetrievalSummary,
} from "./types";
import type { NormalizedModelUsage } from "@reader/api/ai-usage";

const REPORT_DIR = path.resolve(__dirname, "../reports");

const mean = (values: number[]) =>
    values.length
        ? values.reduce((total, value) => total + value, 0) / values.length
        : 0;

export const percentile = (values: number[], quantile: number) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
};

export const maxDuplicateSimilarity = (
    sources: PreparedEvalCase["sources"]
) => {
    let maximum = 0;
    for (let left = 0; left < sources.length; left += 1) {
        for (let right = left + 1; right < sources.length; right += 1) {
            maximum = Math.max(
                maximum,
                wordTrigramJaccard(
                    sources[left].excerpt,
                    sources[right].excerpt
                )
            );
        }
    }
    return maximum;
};

const emptyUsage = (): NormalizedModelUsage => ({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
});

const sumUsage = (
    values: Array<NormalizedModelUsage | null>
): NormalizedModelUsage | null =>
    values.some((value) => value === null)
        ? null
        : values.reduce<NormalizedModelUsage>((total, value) => {
              total.inputTokens += value!.inputTokens;
              total.cachedInputTokens += value!.cachedInputTokens;
              total.outputTokens += value!.outputTokens;
              total.totalTokens += value!.totalTokens;
              return total;
          }, emptyUsage());

const sumCosts = (values: Array<number | null>) =>
    values.some((value) => value === null)
        ? null
        : values.reduce<number>((total, value) => total + value!, 0);

const delta = (reranked: number, baseline: number) => reranked - baseline;

type RetrievalEvaluation = {
    summary: RetrievalSummary;
    cases: RetrievalCaseResult[];
};

type AnswerEvaluation = {
    summary: AnswerSummary;
    cases: AnswerCaseResult[];
};

export interface RerankComparisonReport {
    runId: string;
    createdAt: string;
    infrastructurePassed: boolean;
    promotionPassed: boolean;
    error: string | null;
    answerModels: string[];
    fixtures: RagEvalFixture[];
    ingestion: RagEvalIngestion[];
    judgedAnswerCount: number;
    pairedRetrieval: Array<Record<string, unknown>>;
    pairedAnswers: Array<Record<string, unknown>>;
    aggregate: Record<string, unknown>;
    latencyMs: Record<string, { p50: number; p95: number }>;
    usage: Record<string, NormalizedModelUsage | null>;
    estimatedCostUsd: Record<string, number | null>;
    promotion: {
        checks: Record<string, boolean>;
        failedChecks: string[];
    };
}

const latencySummary = (values: number[]) => ({
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
});

export const assertRerankComparisonMatrix = ({
    cases,
    answerModels,
    pipelineVersions,
    maxJudgedAnswers,
}: {
    cases: RagEvalCase[];
    answerModels: string[];
    pipelineVersions: string[];
    maxJudgedAnswers: number;
}) => {
    const judgedAnswerCount =
        cases.length * answerModels.length * pipelineVersions.length;
    if (
        cases.length !== 7 ||
        new Set(cases.map((testCase) => testCase.id)).size !== 7 ||
        cases.some((testCase) => testCase.suite !== "required")
    ) {
        throw new Error("Rerank comparison requires exactly 7 required cases");
    }
    if (answerModels.length !== 3 || new Set(answerModels).size !== 3) {
        throw new Error("Rerank comparison requires exactly 3 answer models");
    }
    if (
        pipelineVersions.length !== 2 ||
        !pipelineVersions.includes("baseline-rag-v1") ||
        !pipelineVersions.includes("rerank-rag-v1")
    ) {
        throw new Error(
            "Rerank comparison requires baseline-rag-v1 and rerank-rag-v1"
        );
    }
    if (judgedAnswerCount !== 42 || judgedAnswerCount > maxJudgedAnswers) {
        throw new Error(
            `Rerank comparison requires exactly 42 judged answers under cap ${maxJudgedAnswers}`
        );
    }
    return judgedAnswerCount;
};

export const assertPreparedRerankMatrix = ({
    baselineCases,
    rerankedCases,
    answerModels,
    maxJudgedAnswers,
}: {
    baselineCases: PreparedEvalCase[];
    rerankedCases: PreparedEvalCase[];
    answerModels: string[];
    maxJudgedAnswers: number;
}) => {
    const validatePipeline = (
        cases: PreparedEvalCase[],
        pipelineVersion: string
    ) => {
        const ids = new Set(cases.map((testCase) => testCase.id));
        if (
            cases.length !== 21 ||
            ids.size !== 7 ||
            cases.some(
                (testCase) =>
                    testCase.suite !== "required" ||
                    testCase.pipelineVersion !== pipelineVersion
            )
        ) {
            throw new Error(
                `${pipelineVersion} requires 21 generated answers across 7 required cases`
            );
        }
        for (const id of ids) {
            const models = cases
                .filter((testCase) => testCase.id === id)
                .map((testCase) => testCase.answerModel);
            if (
                models.length !== 3 ||
                new Set(models).size !== 3 ||
                answerModels.some((model) => !models.includes(model))
            ) {
                throw new Error(
                    `${pipelineVersion} case ${id} requires all 3 answer models`
                );
            }
        }
    };
    validatePipeline(baselineCases, "baseline-rag-v1");
    validatePipeline(rerankedCases, "rerank-rag-v1");
    const total = baselineCases.length + rerankedCases.length;
    if (total !== 42 || total > maxJudgedAnswers || total > 50) {
        throw new Error(
            `Rerank comparison requires 42 generated answers under cap ${Math.min(maxJudgedAnswers, 50)}`
        );
    }
    return total;
};

export const createRerankComparisonReport = ({
    baselineRetrieval,
    rerankedRetrieval,
    baselineAnswers,
    rerankedAnswers,
    baselineCases,
    rerankedCases,
    fixtures,
    ingestion,
    answerModels,
}: {
    baselineRetrieval: RetrievalEvaluation;
    rerankedRetrieval: RetrievalEvaluation;
    baselineAnswers: AnswerEvaluation;
    rerankedAnswers: AnswerEvaluation;
    baselineCases: PreparedEvalCase[];
    rerankedCases: PreparedEvalCase[];
    fixtures: RagEvalFixture[];
    ingestion: RagEvalIngestion[];
    answerModels: string[];
}): RerankComparisonReport => {
    const uniqueBaselineCases = [
        ...new Map(
            baselineCases.map((testCase) => [testCase.id, testCase])
        ).values(),
    ];
    const uniqueRerankedCases = [
        ...new Map(
            rerankedCases.map((testCase) => [testCase.id, testCase])
        ).values(),
    ];
    const baselineRetrievalById = new Map(
        baselineRetrieval.cases.map((result) => [result.id, result])
    );
    const rerankedRetrievalById = new Map(
        rerankedRetrieval.cases.map((result) => [result.id, result])
    );
    const baselinePreparedById = new Map(
        uniqueBaselineCases.map((result) => [result.id, result])
    );
    const rerankedPreparedById = new Map(
        uniqueRerankedCases.map((result) => [result.id, result])
    );
    const pairedRetrieval = [...baselineRetrievalById.entries()].map(
        ([id, baseline]) => {
            const reranked = rerankedRetrievalById.get(id);
            const baselinePrepared = baselinePreparedById.get(id);
            const rerankedPrepared = rerankedPreparedById.get(id);
            if (!reranked || !baselinePrepared || !rerankedPrepared) {
                throw new Error(`Missing paired retrieval result for ${id}`);
            }
            const baselineDuplicate = maxDuplicateSimilarity(
                baselinePrepared.sources
            );
            const rerankedDuplicate = maxDuplicateSimilarity(
                rerankedPrepared.sources
            );
            return {
                id,
                baseline: {
                    recallAtK: baseline.recallAtK,
                    evidenceCoverage: baseline.evidenceCoverage,
                    reciprocalRank: baseline.reciprocalRank,
                    duplicateSimilarity: baselineDuplicate,
                    passed: baseline.passed,
                },
                reranked: {
                    recallAtK: reranked.recallAtK,
                    evidenceCoverage: reranked.evidenceCoverage,
                    reciprocalRank: reranked.reciprocalRank,
                    duplicateSimilarity: rerankedDuplicate,
                    passed: reranked.passed,
                },
                delta: {
                    recallAtK: delta(reranked.recallAtK, baseline.recallAtK),
                    evidenceCoverage: delta(
                        reranked.evidenceCoverage,
                        baseline.evidenceCoverage
                    ),
                    reciprocalRank: delta(
                        reranked.reciprocalRank,
                        baseline.reciprocalRank
                    ),
                    duplicateSimilarity: delta(
                        rerankedDuplicate,
                        baselineDuplicate
                    ),
                },
            };
        }
    );

    const answerKey = (result: AnswerCaseResult) =>
        `${result.id}:${result.answerModel}`;
    const rerankedAnswerByKey = new Map(
        rerankedAnswers.cases.map((result) => [answerKey(result), result])
    );
    const pairedAnswers = baselineAnswers.cases.map((baseline) => {
        const reranked = rerankedAnswerByKey.get(answerKey(baseline));
        if (!reranked) {
            throw new Error(
                `Missing paired answer result for ${answerKey(baseline)}`
            );
        }
        return {
            id: baseline.id,
            answerModel: baseline.answerModel,
            baseline: { scores: baseline.scores, passed: baseline.passed },
            reranked: { scores: reranked.scores, passed: reranked.passed },
            delta: {
                groundedness: delta(
                    reranked.scores.groundedness,
                    baseline.scores.groundedness
                ),
                citationCoverage: delta(
                    reranked.scores.citationCoverage,
                    baseline.scores.citationCoverage
                ),
                refusalCorrectness: delta(
                    reranked.scores.refusalCorrectness,
                    baseline.scores.refusalCorrectness
                ),
                hallucinationRate: delta(
                    reranked.scores.hallucinationRate,
                    baseline.scores.hallucinationRate
                ),
            },
        };
    });

    const baselineDuplicateValues = pairedRetrieval.map(
        (pair) =>
            (pair.baseline as { duplicateSimilarity: number })
                .duplicateSimilarity
    );
    const rerankedDuplicateValues = pairedRetrieval.map(
        (pair) =>
            (pair.reranked as { duplicateSimilarity: number })
                .duplicateSimilarity
    );
    const rerankerDiagnostics = uniqueRerankedCases.map((testCase) => {
        const diagnostics = testCase.retrievalDiagnostics;
        if (diagnostics?.mode !== "reranked") {
            throw new Error(`Missing reranker diagnostics for ${testCase.id}`);
        }
        return diagnostics.reranker;
    });
    const knownRerankerCosts = rerankerDiagnostics
        .map((diagnostic) => diagnostic.estimatedCost?.amount ?? null)
        .filter((value): value is number => value !== null);
    const highDuplicateReductionPassed = pairedRetrieval
        .filter(
            (pair) =>
                (pair.baseline as { duplicateSimilarity: number })
                    .duplicateSimilarity > 0.85
        )
        .every((pair) => {
            const baseline = (pair.baseline as { duplicateSimilarity: number })
                .duplicateSimilarity;
            const reranked = (pair.reranked as { duplicateSimilarity: number })
                .duplicateSimilarity;
            return reranked <= baseline * 0.9;
        });
    const noRequiredCaseLost =
        pairedRetrieval.every(
            (pair) =>
                !(pair.baseline as { passed: boolean }).passed ||
                (pair.reranked as { passed: boolean }).passed
        ) &&
        pairedAnswers.every(
            (pair) =>
                !(pair.baseline as { passed: boolean }).passed ||
                (pair.reranked as { passed: boolean }).passed
        );
    const rerankerFallbackCount = rerankerDiagnostics.filter(
        (diagnostic) => diagnostic.status === "fallback"
    ).length;
    const rerankerLatencies = rerankerDiagnostics.map(
        (diagnostic) => diagnostic.durationMs
    );
    const checks = {
        noRequiredCaseLost,
        recallAtKNonRegression:
            rerankedRetrieval.summary.recallAtK >=
            baselineRetrieval.summary.recallAtK,
        evidenceCoverageNonRegression:
            rerankedRetrieval.summary.evidenceCoverage >=
            baselineRetrieval.summary.evidenceCoverage,
        mrrNonRegression:
            rerankedRetrieval.summary.mrr >= baselineRetrieval.summary.mrr,
        groundednessBudget:
            rerankedAnswers.summary.groundedness >=
            baselineAnswers.summary.groundedness - 0.05,
        citationCoverageBudget:
            rerankedAnswers.summary.citationCoverage >=
            baselineAnswers.summary.citationCoverage - 0.05,
        refusalCorrectnessBudget:
            rerankedAnswers.summary.refusalCorrectness >=
            baselineAnswers.summary.refusalCorrectness - 0.05,
        hallucinationBudget:
            rerankedAnswers.summary.hallucinationRate <=
            baselineAnswers.summary.hallucinationRate + 0.05,
        duplicateSimilarityNonIncrease:
            mean(rerankedDuplicateValues) <= mean(baselineDuplicateValues),
        highDuplicateReduction: highDuplicateReductionPassed,
        zeroLiveRerankerFallbacks: rerankerFallbackCount === 0,
        rerankerP95AtMost2500Ms: percentile(rerankerLatencies, 0.95) <= 2_500,
        rerankerCostAtMost0015: knownRerankerCosts.every(
            (cost) => cost <= 0.015
        ),
    };
    const failedChecks = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);
    const baselineAnswerCosts = baselineAnswers.cases.map(
        (result) => result.answerEstimatedCost?.amount ?? null
    );
    const rerankedAnswerCosts = rerankedAnswers.cases.map(
        (result) => result.answerEstimatedCost?.amount ?? null
    );
    const baselineJudgeCosts = baselineAnswers.cases.map(
        (result) => result.judgeEstimatedCost?.amount ?? null
    );
    const rerankedJudgeCosts = rerankedAnswers.cases.map(
        (result) => result.judgeEstimatedCost?.amount ?? null
    );
    const rerankerCosts = rerankerDiagnostics.map(
        (diagnostic) => diagnostic.estimatedCost?.amount ?? null
    );

    return {
        runId: `rerank-comparison-${Date.now()}`,
        createdAt: new Date().toISOString(),
        infrastructurePassed: true,
        promotionPassed: failedChecks.length === 0,
        error: null,
        answerModels,
        fixtures,
        ingestion,
        judgedAnswerCount:
            baselineAnswers.cases.length + rerankedAnswers.cases.length,
        pairedRetrieval,
        pairedAnswers,
        aggregate: {
            baseline: {
                retrieval: baselineRetrieval.summary,
                answers: baselineAnswers.summary,
                duplicateSimilarity: mean(baselineDuplicateValues),
            },
            reranked: {
                retrieval: rerankedRetrieval.summary,
                answers: rerankedAnswers.summary,
                duplicateSimilarity: mean(rerankedDuplicateValues),
                fallbackRate:
                    rerankerFallbackCount / rerankerDiagnostics.length,
            },
            delta: {
                recallAtK: delta(
                    rerankedRetrieval.summary.recallAtK,
                    baselineRetrieval.summary.recallAtK
                ),
                evidenceCoverage: delta(
                    rerankedRetrieval.summary.evidenceCoverage,
                    baselineRetrieval.summary.evidenceCoverage
                ),
                mrr: delta(
                    rerankedRetrieval.summary.mrr,
                    baselineRetrieval.summary.mrr
                ),
                groundedness: delta(
                    rerankedAnswers.summary.groundedness,
                    baselineAnswers.summary.groundedness
                ),
                citationCoverage: delta(
                    rerankedAnswers.summary.citationCoverage,
                    baselineAnswers.summary.citationCoverage
                ),
                refusalCorrectness: delta(
                    rerankedAnswers.summary.refusalCorrectness,
                    baselineAnswers.summary.refusalCorrectness
                ),
                hallucinationRate: delta(
                    rerankedAnswers.summary.hallucinationRate,
                    baselineAnswers.summary.hallucinationRate
                ),
                duplicateSimilarity: delta(
                    mean(rerankedDuplicateValues),
                    mean(baselineDuplicateValues)
                ),
            },
        },
        latencyMs: {
            baselineRetrieval: latencySummary(
                uniqueBaselineCases.map(
                    (testCase) => testCase.retrievalDurationMs
                )
            ),
            rerankedFirstStage: latencySummary(
                uniqueRerankedCases.map((testCase) => {
                    const diagnostics = testCase.retrievalDiagnostics;
                    return diagnostics?.mode === "reranked"
                        ? diagnostics.firstStage.durationMs
                        : 0;
                })
            ),
            reranker: latencySummary(rerankerLatencies),
            rerankedRetrieval: latencySummary(
                uniqueRerankedCases.map(
                    (testCase) => testCase.retrievalDurationMs
                )
            ),
            baselineAnswer: latencySummary(
                baselineAnswers.cases.map(
                    (result) => result.generationDurationMs
                )
            ),
            rerankedAnswer: latencySummary(
                rerankedAnswers.cases.map(
                    (result) => result.generationDurationMs
                )
            ),
            baselineJudge: latencySummary(
                baselineAnswers.cases.map((result) => result.judgeDurationMs)
            ),
            rerankedJudge: latencySummary(
                rerankedAnswers.cases.map((result) => result.judgeDurationMs)
            ),
        },
        usage: {
            reranker: sumUsage(
                rerankerDiagnostics.map((diagnostic) => diagnostic.usage)
            ),
            baselineAnswers: sumUsage(
                baselineAnswers.cases.map((result) => result.answerUsage)
            ),
            rerankedAnswers: sumUsage(
                rerankedAnswers.cases.map((result) => result.answerUsage)
            ),
            baselineJudge: sumUsage(
                baselineAnswers.cases.map((result) => result.judgeUsage)
            ),
            rerankedJudge: sumUsage(
                rerankedAnswers.cases.map((result) => result.judgeUsage)
            ),
        },
        estimatedCostUsd: {
            reranker: sumCosts(rerankerCosts),
            baselineAnswers: sumCosts(baselineAnswerCosts),
            rerankedAnswers: sumCosts(rerankedAnswerCosts),
            baselineJudge: sumCosts(baselineJudgeCosts),
            rerankedJudge: sumCosts(rerankedJudgeCosts),
            total: sumCosts([
                ...rerankerCosts,
                ...baselineAnswerCosts,
                ...rerankedAnswerCosts,
                ...baselineJudgeCosts,
                ...rerankedJudgeCosts,
            ]),
        },
        promotion: { checks, failedChecks },
    };
};

export const createInfrastructureFailureReport = (
    error: unknown
): RerankComparisonReport => ({
    runId: `rerank-comparison-${Date.now()}`,
    createdAt: new Date().toISOString(),
    infrastructurePassed: false,
    promotionPassed: false,
    error: error instanceof Error ? error.message : String(error),
    answerModels: [],
    fixtures: [],
    ingestion: [],
    judgedAnswerCount: 0,
    pairedRetrieval: [],
    pairedAnswers: [],
    aggregate: {},
    latencyMs: {},
    usage: {},
    estimatedCostUsd: {},
    promotion: {
        checks: { infrastructurePassed: false },
        failedChecks: ["infrastructurePassed"],
    },
});

const formatNumber = (value: unknown) =>
    typeof value === "number" ? value.toFixed(4) : "n/a";

export const renderRerankComparisonMarkdown = (
    report: RerankComparisonReport
) => {
    const aggregate = report.aggregate as {
        baseline?: { duplicateSimilarity?: number };
        reranked?: { duplicateSimilarity?: number; fallbackRate?: number };
        delta?: Record<string, number>;
    };
    return (
        [
            "# Reader Reranking Comparison",
            "",
            `- Run: ${report.runId}`,
            `- Infrastructure passed: ${report.infrastructurePassed}`,
            `- Promotion passed: ${report.promotionPassed}`,
            `- Judged answers: ${report.judgedAnswerCount}`,
            `- Error: ${report.error ?? "none"}`,
            `- Reranker p50/p95: ${report.latencyMs.reranker?.p50 ?? 0}/${report.latencyMs.reranker?.p95 ?? 0} ms`,
            `- Reranker fallback rate: ${formatNumber(aggregate.reranked?.fallbackRate)}`,
            `- Baseline/reranked duplicate similarity: ${formatNumber(aggregate.baseline?.duplicateSimilarity)}/${formatNumber(aggregate.reranked?.duplicateSimilarity)}`,
            `- Estimated reranker cost: ${formatNumber(report.estimatedCostUsd.reranker)}`,
            `- Estimated total cost: ${formatNumber(report.estimatedCostUsd.total)}`,
            "",
            "## Stage latency p50/p95",
            "",
            ...Object.entries(report.latencyMs).map(
                ([stage, latency]) =>
                    `- ${stage}: ${latency.p50}/${latency.p95} ms`
            ),
            "",
            "## Usage",
            "",
            ...Object.entries(report.usage).map(
                ([stage, usage]) =>
                    `- ${stage}: ${usage === null ? "unknown" : JSON.stringify(usage)}`
            ),
            "",
            "## Estimated costs USD",
            "",
            ...Object.entries(report.estimatedCostUsd).map(
                ([stage, cost]) => `- ${stage}: ${formatNumber(cost)}`
            ),
            "",
            "## Promotion checks",
            "",
            ...Object.entries(report.promotion.checks).map(
                ([name, passed]) => `- ${name}: ${passed}`
            ),
            "",
            "## Aggregate deltas",
            "",
            ...Object.entries(aggregate.delta ?? {}).map(
                ([name, value]) => `- ${name}: ${formatNumber(value)}`
            ),
            "",
            "## Paired retrieval deltas",
            "",
            ...report.pairedRetrieval.map(
                (pair) => `- ${String(pair.id)}: ${JSON.stringify(pair.delta)}`
            ),
            "",
            "## Paired answer deltas",
            "",
            ...report.pairedAnswers.map(
                (pair) =>
                    `- ${String(pair.id)} / ${String(pair.answerModel)}: ${JSON.stringify(pair.delta)}`
            ),
        ].join("\n") + "\n"
    );
};

export const writeRerankComparisonReport = async (
    report: RerankComparisonReport
) => {
    await fs.mkdir(REPORT_DIR, { recursive: true });
    const jsonPath = path.join(REPORT_DIR, "latest-rerank-comparison.json");
    const markdownPath = path.join(REPORT_DIR, "latest-rerank-comparison.md");
    await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    await fs.writeFile(markdownPath, renderRerankComparisonMarkdown(report));
    return { jsonPath, markdownPath };
};

export const writeInfrastructureFailureReport = async (error: unknown) => {
    const report = createInfrastructureFailureReport(error);
    const paths = await writeRerankComparisonReport(report);
    return { report, paths };
};
