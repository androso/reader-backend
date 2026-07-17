import fs from "node:fs/promises";
import path from "node:path";
import type { RagEvalReport } from "./types";
import {
    AI_PRICING_VERSION,
    type NormalizedModelUsage,
} from "@reader/api/ai-usage";

const REPORT_DIR = path.resolve(__dirname, "../reports");

const percent = (value: number | null) =>
    value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

export const createReport = (
    report: Omit<
        RagEvalReport,
        "runId" | "createdAt" | "qualityPassed" | "regression"
    >
): RagEvalReport => ({
    ...report,
    runId: `rag-eval-${Date.now()}`,
    createdAt: new Date().toISOString(),
    qualityPassed:
        report.retrieval.summary.passed && report.answers.summary.passed,
    regression: null,
});

const emptyUsage = (): NormalizedModelUsage => ({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
});

const sumUsage = (
    values: Array<NormalizedModelUsage | null>
): NormalizedModelUsage | null =>
    values.some((usage) => usage === null)
        ? null
        : values.reduce<NormalizedModelUsage>((total, usage) => {
              return {
                  inputTokens: total.inputTokens + usage!.inputTokens,
                  cachedInputTokens:
                      total.cachedInputTokens + usage!.cachedInputTokens,
                  outputTokens: total.outputTokens + usage!.outputTokens,
                  totalTokens: total.totalTokens + usage!.totalTokens,
              };
          }, emptyUsage());

const sumCost = (
    values: Array<{ amount: number } | null>
): number | null =>
    values.some((cost) => cost === null)
        ? null
        : values.reduce((total, cost) => total + cost!.amount, 0);

const formatCost = (value: number | null) =>
    value === null ? "unknown" : `$${value.toFixed(6)}`;

const formatUsage = (value: NormalizedModelUsage | null) =>
    value === null ? "unknown" : String(value.totalTokens);

export const summarizeExecution = ({
    retrieval,
    answers,
}: Pick<
    RagEvalReport,
    "retrieval" | "answers"
>): RagEvalReport["execution"] => {
    const retrievalLatency = retrieval.cases.reduce(
        (total, result) => total + result.retrievalDurationMs,
        0
    );
    const generationLatency = answers.cases.reduce(
        (total, result) => total + result.generationDurationMs,
        0
    );
    const judgeLatency = answers.cases.reduce(
        (total, result) => total + result.judgeDurationMs,
        0
    );
    const answerCost = sumCost(
        answers.cases.map((result) => result.answerEstimatedCost)
    );
    const judgeCost = sumCost(
        answers.cases.map((result) => result.judgeEstimatedCost)
    );
    const totalCost =
        answerCost === null || judgeCost === null
            ? null
            : answerCost + judgeCost;

    return {
        pipelineVersions: [
            ...new Set(retrieval.cases.map((result) => result.pipelineVersion)),
        ],
        promptVersions: [
            ...new Set(retrieval.cases.map((result) => result.promptVersion)),
        ],
        pricingVersion: AI_PRICING_VERSION,
        latencyMs: {
            retrieval: retrievalLatency,
            generation: generationLatency,
            judge: judgeLatency,
            total: retrievalLatency + generationLatency + judgeLatency,
        },
        usage: {
            answers: sumUsage(
                answers.cases.map((result) => result.answerUsage)
            ),
            judge: sumUsage(answers.cases.map((result) => result.judgeUsage)),
        },
        estimatedCostUsd: {
            answers: answerCost,
            judge: judgeCost,
            total: totalCost,
            embeddingIncluded: false,
        },
    };
};

export const renderMarkdownReport = (report: RagEvalReport) => {
    const lines = [
        `# Reader RAG Eval Report`,
        "",
        `- Run: ${report.runId}`,
        `- Created: ${report.createdAt}`,
        `- Suite: ${report.suite}`,
        `- Quality passed: ${report.qualityPassed}`,
        `- Fixtures: ${report.fixtures.map((fixture) => `${fixture.title} by ${fixture.author}`).join("; ")}`,
        `- Fixture SHA-256: ${report.fixtures.map((fixture) => `${fixture.id}=${fixture.sha256}`).join(", ")}`,
        `- Source revisions: ${report.fixtures.map((fixture) => `${fixture.id}=${fixture.sourceRevision}`).join(", ")}`,
        `- Collections: ${report.ingestion.map((entry) => `${entry.fixtureId}=${entry.collectionName}`).join(", ")}`,
        `- Extracted/stored chunks: ${report.ingestion.map((entry) => `${entry.fixtureId}=${entry.extractedChunkCount}/${entry.storedChunkCount}`).join(", ")}`,
        `- Requested answer models: ${report.answerModels.join(", ")}`,
        `- Resolved answer models: ${report.resolvedAnswerModels.join(", ")}`,
        `- Requested judge model: ${report.judgeModel}`,
        `- Resolved judge models: ${report.resolvedJudgeModels.join(", ")}`,
        `- Pipeline versions: ${report.execution.pipelineVersions.join(", ")}`,
        `- Prompt versions: ${report.execution.promptVersions.join(", ")}`,
        `- Pricing version: ${report.execution.pricingVersion}`,
        `- Total measured latency: ${report.execution.latencyMs.total} ms`,
        `- Answer/judge tokens: ${formatUsage(report.execution.usage.answers)}/${formatUsage(report.execution.usage.judge)}`,
        `- Estimated answer cost: ${formatCost(report.execution.estimatedCostUsd.answers)}`,
        `- Estimated judge cost: ${formatCost(report.execution.estimatedCostUsd.judge)}`,
        `- Estimated total cost: ${formatCost(report.execution.estimatedCostUsd.total)}`,
        `- Embedding cost included: ${report.execution.estimatedCostUsd.embeddingIncluded}`,
    ];

    if (report.retrieval) {
        const summary = report.retrieval.summary;
        lines.push(
            "",
            "## Retrieval",
            "",
            `- Passed: ${summary.passed}`,
            `- Cases: ${summary.caseCount}`,
            `- Recall@k: ${percent(summary.recallAtK)}`,
            `- Evidence coverage: ${percent(summary.evidenceCoverage)}`,
            `- MRR: ${summary.mrr.toFixed(3)}`,
            `- Source hit rate: ${percent(summary.sourceHitRate)}`,
            `- Vector source hit rate: ${percent(summary.vectorSourceHitRate)}`,
            `- Vector MRR: ${summary.vectorMrr.toFixed(3)}`,
            `- Vector/database ID alignment: ${percent(summary.vectorIdAlignmentRate)}`,
            `- Chunk/window hit rate: ${percent(summary.chunkWindowHitRate)}`,
            `- Chapter accuracy: ${percent(summary.chapterAccuracy)}`
        );
        for (const [category, slice] of Object.entries(summary.perCategory)) {
            lines.push(
                `- ${category}: ${slice.caseCount} cases, evidence ${percent(slice.evidenceCoverage)}, passed ${slice.passed}`
            );
        }
    }

    if (report.answers) {
        const summary = report.answers.summary;
        lines.push(
            "",
            "## Answers",
            "",
            `- Passed: ${summary.passed}`,
            `- Cases: ${summary.caseCount}`,
            `- Groundedness: ${percent(summary.groundedness)}`,
            `- Citation coverage: ${percent(summary.citationCoverage)}`,
            `- Refusal correctness: ${percent(summary.refusalCorrectness)}`,
            `- Hallucination rate: ${percent(summary.hallucinationRate)}`
        );
        for (const [category, slice] of Object.entries(summary.perCategory)) {
            lines.push(
                `- ${category}: ${slice.caseCount} cases, groundedness ${percent(slice.groundedness)}, passed ${slice.passed}`
            );
        }
    }

    return `${lines.join("\n")}\n`;
};

export const writeReport = async (report: RagEvalReport) => {
    await fs.mkdir(REPORT_DIR, { recursive: true });
    const jsonPath = path.join(REPORT_DIR, "latest.json");
    const markdownPath = path.join(REPORT_DIR, "latest.md");
    await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    await fs.writeFile(markdownPath, renderMarkdownReport(report));
    return { jsonPath, markdownPath };
};
