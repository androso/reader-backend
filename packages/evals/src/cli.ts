import {
    getEvalThresholds,
    getJudgeMaxCases,
    getJudgeModel,
    hasLangfuseConfig,
    hasOpenAiConfig,
    shouldFailEvalCommand,
} from "./config";
import type { EvalCommand } from "./config";
import {
    computeBaselineInputHashes,
    evaluateBaselineRegression,
    loadBaselineReference,
} from "./baselineRegression";
import { loadGoldenDataset } from "./dataset";
import { runAnswerEval } from "./answerJudge";
import {
    syncReportToLangfuse,
    syncRerankComparisonToLangfuse,
} from "./langfuse";
import { runLiveRagEval } from "./liveEval";
import { createReport, summarizeExecution, writeReport } from "./report";
import { scoreRetrievalEval } from "./retrieval";
import {
    createRerankComparisonReport,
    assertRerankComparisonMatrix,
    assertPreparedRerankMatrix,
    writeRerankComparisonReport,
    writeInfrastructureFailureReport,
} from "./rerankComparison";
import { OPENAI_CHAT_MODELS } from "@reader/api/rag";

const fail = (message: string): never => {
    console.error(message);
    process.exit(1);
};

const persistAndPrint = async (report: Parameters<typeof writeReport>[0]) => {
    const paths = await writeReport(report);
    console.log(`Wrote ${paths.jsonPath}`);
    console.log(`Wrote ${paths.markdownPath}`);
};

const runRerankComparison = async () => {
    let reportWritten = false;
    try {
        if (!hasOpenAiConfig()) {
            throw new Error("OPENAI_API_KEY is required for live RAG evals");
        }
        const thresholds = getEvalThresholds();
        const cases = await loadGoldenDataset(undefined, "required");
        const pipelineVersions = ["baseline-rag-v1", "rerank-rag-v1"] as const;
        const expectedJudgedAnswers = assertRerankComparisonMatrix({
            cases,
            answerModels: [...OPENAI_CHAT_MODELS],
            pipelineVersions: [...pipelineVersions],
            maxJudgedAnswers: Math.min(50, getJudgeMaxCases()),
        });
        const live = await runLiveRagEval(cases, {
            pipelineVersions: [...pipelineVersions],
        });
        const baselineCases = live.cases.filter(
            (testCase) => testCase.pipelineVersion === "baseline-rag-v1"
        );
        const rerankedCases = live.cases.filter(
            (testCase) => testCase.pipelineVersion === "rerank-rag-v1"
        );
        const baselineRetrievalCases = live.retrievalCases.filter(
            (testCase) => testCase.pipelineVersion === "baseline-rag-v1"
        );
        const rerankedRetrievalCases = live.retrievalCases.filter(
            (testCase) => testCase.pipelineVersion === "rerank-rag-v1"
        );
        const generatedAnswerCount = assertPreparedRerankMatrix({
            baselineCases,
            rerankedCases,
            answerModels: live.answerModels,
            maxJudgedAnswers: Math.min(50, getJudgeMaxCases()),
        });
        if (generatedAnswerCount !== expectedJudgedAnswers) {
            throw new Error(
                "Generated rerank matrix does not match input matrix"
            );
        }
        const baselineRetrieval = scoreRetrievalEval(
            baselineRetrievalCases,
            thresholds
        );
        const rerankedRetrieval = scoreRetrievalEval(
            rerankedRetrievalCases,
            thresholds
        );
        const baselineAnswers = await runAnswerEval(baselineCases, thresholds);
        const rerankedAnswers = await runAnswerEval(rerankedCases, thresholds);
        const report = createRerankComparisonReport({
            baselineRetrieval,
            rerankedRetrieval,
            baselineAnswers,
            rerankedAnswers,
            baselineCases: baselineRetrievalCases,
            rerankedCases: rerankedRetrievalCases,
            fixtures: live.fixtures,
            ingestion: live.ingestion,
            answerModels: live.answerModels,
        });
        const paths = await writeRerankComparisonReport(report);
        reportWritten = true;
        console.log(`Wrote ${paths.jsonPath}`);
        console.log(`Wrote ${paths.markdownPath}`);
        if (hasLangfuseConfig()) {
            try {
                const result = await syncRerankComparisonToLangfuse(report);
                console.log(JSON.stringify(result, null, 2));
            } catch (error) {
                console.warn(
                    `Langfuse comparison sync failed without changing the promotion result: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
            }
        } else {
            console.log(
                "Skipping Langfuse comparison sync: LANGFUSE_* secrets are absent."
            );
        }
        if (!report.promotionPassed) {
            throw new Error(
                `Reranking promotion gate failed: ${report.promotion.failedChecks.join(", ")}`
            );
        }
    } catch (error) {
        if (!reportWritten) {
            const { paths } = await writeInfrastructureFailureReport(error);
            console.error(`Wrote ${paths.jsonPath}`);
            console.error(`Wrote ${paths.markdownPath}`);
        }
        throw error;
    }
};

const run = async () => {
    const command = process.argv[2] as EvalCommand | "rerank" | undefined;
    if (
        command !== "live" &&
        command !== "ci" &&
        command !== "extended" &&
        command !== "rerank"
    ) {
        fail("Usage: node dist/cli.js <live|ci|extended|rerank>");
    }
    if (command === "rerank") {
        await runRerankComparison();
        return;
    }
    const evalCommand = command as EvalCommand;
    if (!hasOpenAiConfig()) {
        fail("OPENAI_API_KEY is required for live RAG evals");
    }

    const suite = evalCommand === "extended" ? "extended" : "required";
    const thresholds = getEvalThresholds();
    const cases = await loadGoldenDataset(undefined, suite);
    const live = await runLiveRagEval(cases);
    const retrieval = scoreRetrievalEval(live.retrievalCases, thresholds);
    const answers = await runAnswerEval(live.cases, thresholds);
    let report = createReport({
        answerModels: live.answerModels,
        resolvedAnswerModels: live.resolvedAnswerModels,
        judgeModel: getJudgeModel(),
        resolvedJudgeModels: [
            ...new Set(
                answers.cases.map((testCase) => testCase.resolvedJudgeModel)
            ),
        ],
        suite,
        thresholds,
        fixtures: live.fixtures,
        ingestion: live.ingestion,
        retrieval,
        answers,
        execution: summarizeExecution({ retrieval, answers }),
    });
    if (evalCommand === "ci") {
        const [reference, hashes] = await Promise.all([
            loadBaselineReference(),
            computeBaselineInputHashes(),
        ]);
        report = {
            ...report,
            regression: evaluateBaselineRegression({
                reference,
                ...hashes,
                pipelineVersions: report.execution.pipelineVersions,
                promptVersions: report.execution.promptVersions,
                answerModels: report.answerModels,
                judgeModel: report.judgeModel,
                retrieval: report.retrieval,
                answers: report.answers,
            }),
        };
    }
    await persistAndPrint(report);
    console.log(`Absolute quality passed: ${report.qualityPassed}`);
    if (report.regression) {
        console.log(
            `Baseline regression passed: ${report.regression.passed} (${report.regression.referenceVersion})`
        );
        console.log(
            `Observed known gaps: ${report.regression.observedKnownGaps.join(", ") || "none"}`
        );
        console.log(
            `Baseline improvements: ${report.regression.improvements.join(", ") || "none"}`
        );
        if (report.regression.failedChecks.length) {
            console.error(
                `Failed baseline checks: ${report.regression.failedChecks.join(", ")}`
            );
        }
    }

    if (hasLangfuseConfig()) {
        try {
            const result = await syncReportToLangfuse(report, cases);
            console.log(JSON.stringify(result, null, 2));
        } catch (error) {
            console.warn(
                `Langfuse sync failed without changing the quality result: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    } else {
        console.log("Skipping Langfuse sync: LANGFUSE_* secrets are absent.");
    }

    if (
        shouldFailEvalCommand({
            command: evalCommand,
            qualityPassed: report.qualityPassed,
            regressionPassed: report.regression?.passed ?? null,
        })
    ) {
        fail(
            evalCommand === "ci"
                ? "Reader RAG baseline regression gate failed"
                : "Live Reader RAG quality gate failed"
        );
    }
    if (suite === "extended" && !report.qualityPassed) {
        console.warn(
            "Extended Reader RAG quality misses were reported without failing the manual workflow."
        );
    }
};

run().catch((error) => {
    fail(error instanceof Error ? error.stack || error.message : String(error));
});
