import type { RagEvalCase, RagEvalReport } from "./types";
import { getLangfuseDatasetName } from "./config";

type LangfuseClientLike = {
    api?: {
        datasets?: {
            create?: (input: unknown) => Promise<unknown>;
        };
        scores?: {
            create?: (input: unknown) => Promise<unknown>;
        };
    };
    dataset?: {
        create?: (name: string) => Promise<unknown>;
        createItem?: (input: unknown) => Promise<unknown>;
    };
};

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

    if (!client.api?.scores?.create) {
        return {
            datasetName,
            syncedItems: cases.length,
            syncedScores: 0,
            warning:
                "Installed Langfuse client does not expose score creation; dataset items were synced.",
        };
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

    for (const result of report.answers?.cases ?? []) {
        await createScore(
            result.id,
            "rag_eval_groundedness",
            result.scores.groundedness
        );
        await createScore(
            result.id,
            "rag_eval_citation_coverage",
            result.scores.citationCoverage
        );
        await createScore(
            result.id,
            "rag_eval_hallucination_rate",
            result.scores.hallucinationRate
        );
    }

    return { datasetName, syncedItems: cases.length, syncedScores };
};
