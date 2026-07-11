import crypto from "node:crypto";
import type { RagEvalCase, RagEvalReport } from "./types";
import { getLangfuseDatasetName } from "./config";

type LangfuseIngestionResponse = {
    errors?: Array<{ id: string; message?: string }>;
};

type LangfuseClientLike = {
    api?: {
        datasets?: {
            create?: (input: unknown) => Promise<unknown>;
        };
        scores?: {
            create?: (input: unknown) => Promise<unknown>;
        };
        ingestion?: {
            batch?: (input: unknown) => Promise<LangfuseIngestionResponse>;
        };
    };
    dataset?: {
        create?: (name: string) => Promise<unknown>;
        createItem?: (input: unknown) => Promise<unknown>;
    };
};

const createTraceId = (runId: string, caseId: string) =>
    crypto
        .createHash("sha256")
        .update(`${runId}:${caseId}`)
        .digest("hex")
        .slice(0, 32);

const createDatasetItemId = (datasetName: string, caseId: string) =>
    `reader-rag-${crypto
        .createHash("sha256")
        .update(`${datasetName}:${caseId}`)
        .digest("hex")
        .slice(0, 32)}`;

export const createLangfuseClient = async (): Promise<LangfuseClientLike> => {
    const module = await import("@langfuse/client");
    const LangfuseClient = (module as any).LangfuseClient;
    if (!LangfuseClient) {
        throw new Error("@langfuse/client did not export LangfuseClient");
    }

    return new LangfuseClient({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl: process.env.LANGFUSE_BASE_URL || undefined,
    }) as LangfuseClientLike;
};

const ignoreAlreadyExists = async (operation: () => Promise<unknown>) => {
    try {
        await operation();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already exists|conflict|409/i.test(message)) {
            throw error;
        }
    }
};

export const syncReportToLangfuse = async (
    report: RagEvalReport,
    cases: RagEvalCase[],
    clientPromise = createLangfuseClient()
) => {
    const client = await clientPromise;
    const datasetName = getLangfuseDatasetName();

    if (client.api?.datasets?.create) {
        await ignoreAlreadyExists(() =>
            client.api!.datasets!.create!({
                name: datasetName,
                description: "Reader live real-book RAG golden dataset",
                metadata: {
                    source: "packages/evals",
                    runId: report.runId,
                },
            })
        );
    } else if (client.dataset?.create) {
        await ignoreAlreadyExists(() => client.dataset!.create!(datasetName));
    } else {
        throw new Error("Installed Langfuse client does not support datasets");
    }

    if (!client.dataset?.createItem) {
        throw new Error(
            "Installed Langfuse client does not support dataset items"
        );
    }

    for (const testCase of cases) {
        await ignoreAlreadyExists(() =>
            client.dataset!.createItem!({
                id: createDatasetItemId(datasetName, testCase.id),
                datasetName,
                input: {
                    id: testCase.id,
                    question: testCase.question,
                    fixtureSha256: report.fixture.sha256,
                },
                expectedOutput: {
                    answer: testCase.expectedAnswer,
                    evidenceText: testCase.expectedEvidenceText,
                    chapterTitle: testCase.expectedChapterTitle,
                    noAnswerExpected: Boolean(testCase.noAnswerExpected),
                },
                metadata: {
                    source: "packages/evals",
                    runId: report.runId,
                },
            })
        );
    }

    if (!client.api?.scores?.create || !client.api.ingestion?.batch) {
        return {
            datasetName,
            syncedItems: cases.length,
            syncedScores: 0,
            warning:
                "Installed Langfuse client does not expose trace ingestion and score creation; dataset items were synced.",
        };
    }

    const answerCases = report.answers?.cases ?? [];
    const traceIds = new Map(
        answerCases.map((result) => [
            result.id,
            createTraceId(report.runId, result.id),
        ])
    );
    const ingestion = await client.api.ingestion.batch({
        batch: answerCases.map((result) => ({
            type: "trace-create",
            id: crypto.randomUUID(),
            timestamp: report.createdAt,
            body: {
                id: traceIds.get(result.id),
                timestamp: report.createdAt,
                name: "reader-rag-eval",
                input: result.question,
                output: result.answer,
                metadata: {
                    runId: report.runId,
                    caseId: result.id,
                    source: "packages/evals",
                },
                tags: ["reader-rag-eval"],
            },
        })),
    });
    if (ingestion.errors?.length) {
        throw new Error(
            `Langfuse trace ingestion failed: ${ingestion.errors
                .map((error) => error.message || error.id)
                .join(", ")}`
        );
    }

    let syncedScores = 0;
    const createScore = async (
        caseId: string,
        name: string,
        value: number,
        traceId?: string
    ) => {
        if (!traceId) return;
        await client.api!.scores!.create!({
            name,
            value,
            traceId,
            comment: `Reader RAG eval ${report.runId} case ${caseId}`,
            metadata: {
                runId: report.runId,
                caseId,
                source: "packages/evals",
            },
        });
        syncedScores += 1;
    };

    for (const result of answerCases) {
        const traceId = traceIds.get(result.id);
        await createScore(
            result.id,
            "rag_eval_groundedness",
            result.scores.groundedness,
            traceId
        );
        await createScore(
            result.id,
            "rag_eval_citation_coverage",
            result.scores.citationCoverage,
            traceId
        );
        await createScore(
            result.id,
            "rag_eval_hallucination_rate",
            result.scores.hallucinationRate,
            traceId
        );
    }

    return { datasetName, syncedItems: cases.length, syncedScores };
};
