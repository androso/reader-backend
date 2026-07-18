import {
    getEvalThresholds,
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
import { syncReportToLangfuse } from "./langfuse";
import { runLiveRagEval } from "./liveEval";
import { createReport, summarizeExecution, writeReport } from "./report";
import { scoreRetrievalEval } from "./retrieval";

const fail = (message: string): never => {
    console.error(message);
    process.exit(1);
};

const persistAndPrint = async (report: Parameters<typeof writeReport>[0]) => {
    const paths = await writeReport(report);
    console.log(`Wrote ${paths.jsonPath}`);
    console.log(`Wrote ${paths.markdownPath}`);
};

const run = async () => {
    const command = process.argv[2] as EvalCommand | undefined;
    if (command !== "live" && command !== "ci" && command !== "extended") {
        fail("Usage: node dist/cli.js <live|ci|extended>");
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
