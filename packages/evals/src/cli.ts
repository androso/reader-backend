import {
    getEvalThresholds,
    getJudgeModel,
    hasLangfuseConfig,
    hasOpenAiConfig,
    shouldFailQualityGate,
} from "./config";
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
    const command = process.argv[2];
    if (command !== "live" && command !== "ci" && command !== "extended") {
        fail("Usage: node dist/cli.js <live|ci|extended>");
    }
    if (!hasOpenAiConfig()) {
        fail("OPENAI_API_KEY is required for live RAG evals");
    }

    const suite = command === "extended" ? "extended" : "required";
    const thresholds = getEvalThresholds();
    const cases = await loadGoldenDataset(undefined, suite);
    const live = await runLiveRagEval(cases);
    const retrieval = scoreRetrievalEval(live.retrievalCases, thresholds);
    const answers = await runAnswerEval(live.cases, thresholds);
    const report = createReport({
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
    await persistAndPrint(report);

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

    if (shouldFailQualityGate(suite, report.qualityPassed)) {
        fail("Live Reader RAG quality gate failed");
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
