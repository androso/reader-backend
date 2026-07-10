import {
    getEvalThresholds,
    getJudgeModel,
    hasLangfuseConfig,
    hasOpenAiConfig,
} from "./config";
import { loadGoldenDataset } from "./dataset";
import { runAnswerEval } from "./answerJudge";
import { syncReportToLangfuse } from "./langfuse";
import { runLiveRagEval } from "./liveEval";
import { createReport, writeReport } from "./report";
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
    if (command !== "live" && command !== "ci") {
        fail("Usage: node dist/cli.js <live|ci>");
    }
    if (!hasOpenAiConfig()) {
        fail("OPENAI_API_KEY is required for live RAG evals");
    }

    const thresholds = getEvalThresholds();
    const cases = await loadGoldenDataset();
    const live = await runLiveRagEval(cases);
    const retrieval = scoreRetrievalEval(live.cases, thresholds);
    const answers = await runAnswerEval(live.cases, thresholds);
    const report = createReport({
        answerModel: live.answerModel,
        judgeModel: getJudgeModel(),
        thresholds,
        fixture: live.fixture,
        ingestion: live.ingestion,
        retrieval,
        answers,
    });
    await persistAndPrint(report);

    if (hasLangfuseConfig()) {
        const result = await syncReportToLangfuse(report, cases);
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log("Skipping Langfuse sync: LANGFUSE_* secrets are absent.");
    }

    if (!retrieval.summary.passed || !answers.summary.passed) {
        fail("Live Reader RAG quality gate failed");
    }
};

run().catch((error) => {
    fail(error instanceof Error ? error.stack || error.message : String(error));
});
