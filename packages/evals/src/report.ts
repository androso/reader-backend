import fs from "node:fs/promises";
import path from "node:path";
import type { RagEvalReport } from "./types";

const REPORT_DIR = path.resolve(__dirname, "../reports");

const percent = (value: number | null) =>
    value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

export const createReport = (
    report: Omit<RagEvalReport, "runId" | "createdAt">
): RagEvalReport => ({
    ...report,
    runId: `rag-eval-${Date.now()}`,
    createdAt: new Date().toISOString(),
});

export const renderMarkdownReport = (report: RagEvalReport) => {
    const lines = [
        `# Reader RAG Eval Report`,
        "",
        `- Run: ${report.runId}`,
        `- Created: ${report.createdAt}`,
        `- Fixture: ${report.fixture.title} by ${report.fixture.author}`,
        `- Fixture SHA-256: ${report.fixture.sha256}`,
        `- Source revision: ${report.fixture.sourceRevision}`,
        `- Collection: ${report.ingestion.collectionName}`,
        `- Extracted/stored chunks: ${report.ingestion.extractedChunkCount}/${report.ingestion.storedChunkCount}`,
        `- Answer models: ${report.answerModels.join(", ")}`,
        `- Judge model: ${report.judgeModel}`,
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
            `- MRR: ${summary.mrr.toFixed(3)}`,
            `- Source hit rate: ${percent(summary.sourceHitRate)}`,
            `- Vector source hit rate: ${percent(summary.vectorSourceHitRate)}`,
            `- Vector MRR: ${summary.vectorMrr.toFixed(3)}`,
            `- Vector/database ID alignment: ${percent(summary.vectorIdAlignmentRate)}`,
            `- Chunk/window hit rate: ${percent(summary.chunkWindowHitRate)}`,
            `- Chapter accuracy: ${percent(summary.chapterAccuracy)}`
        );
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
