import {
    getEvalThresholds,
    getJudgeModel,
    hasLangfuseConfig,
    hasOpenAiConfig,
} from "./config";
import { loadGoldenDataset } from "./dataset";
import { runAnswerEval } from "./answerJudge";
import { syncReportToLangfuse } from "./langfuse";
import { createReport, writeReport } from "./report";
import { runRetrievalEval } from "./retrieval";
import type { RagEvalReport } from "./types";

type Command = "retrieval" | "answers" | "langfuse" | "ci";

const fail = (message: string): never => {
    console.error(message);
    process.exit(1);
};

const assertCommand = (value: string | undefined): Command => {
    if (
        value === "retrieval" ||
        value === "answers" ||
        value === "langfuse" ||
        value === "ci"
    ) {
        return value;
    }

    return fail("Usage: node dist/cli.js <retrieval|answers|langfuse|ci>");
};

const persistAndPrint = async (report: RagEvalReport) => {
    const paths = await writeReport(report);
    console.log(`Wrote ${paths.jsonPath}`);
    console.log(`Wrote ${paths.markdownPath}`);
};

const run = async () => {
    const command = assertCommand(process.argv[2]);
    const thresholds = getEvalThresholds();
    const cases = await loadGoldenDataset();
    const judgeModel = getJudgeModel();
    const retrieval = await runRetrievalEval(cases, thresholds);
    const reportBase = {
        judgeModel,
        thresholds,
        retrieval,
    };

    if (command === "retrieval") {
        const report = createReport(reportBase);
        await persistAndPrint(report);
        if (!retrieval.summary.passed) {
            fail("RAG retrieval eval failed");
        }
        return;
    }

    if (command === "answers") {
        if (!hasOpenAiConfig()) {
            fail("OPENAI_API_KEY is required for answer evals");
        }
        const answers = await runAnswerEval(cases, thresholds);
        const report = createReport({ ...reportBase, answers });
        await persistAndPrint(report);
        if (!retrieval.summary.passed || !answers.summary.passed) {
            fail("RAG answer eval failed");
        }
        return;
    }

    if (command === "langfuse") {
        if (!hasLangfuseConfig()) {
            fail("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required");
        }
        const report = createReport(reportBase);
        await persistAndPrint(report);
        const result = await syncReportToLangfuse(report, cases);
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (command === "ci") {
        const answers = hasOpenAiConfig()
            ? await runAnswerEval(cases, thresholds)
            : undefined;
        const report = createReport({ ...reportBase, answers });
        await persistAndPrint(report);

        if (hasLangfuseConfig()) {
            const result = await syncReportToLangfuse(report, cases);
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log("Skipping Langfuse sync: LANGFUSE_* secrets are absent.");
        }

        if (!hasOpenAiConfig()) {
            console.log("Skipping answer judge eval: OPENAI_API_KEY is absent.");
        }

        if (!retrieval.summary.passed || answers?.summary.passed === false) {
            fail("RAG CI eval failed");
        }
        return;
    }
};

run().catch((error) => {
    fail(error instanceof Error ? error.stack || error.message : String(error));
});
