import crypto from "node:crypto";
import type { RagEvalCase, RagEvalReport } from "./types";
import { getLangfuseDatasetName } from "./config";

type LangfuseClientLike = {
    api?: {
        datasets?: {
            create?: (input: unknown) => Promise<unknown>;
        };
    };
    dataset?: {
        create?: (name: string) => Promise<unknown>;
        createItem?: (input: unknown) => Promise<unknown>;
    };
    score?: {
        create?: (input: unknown) => void;
    };
    flush?: () => Promise<void>;
};

type LangfuseObservationLike = {
    traceId: string;
    update: (attributes: Record<string, unknown>) => unknown;
    end: () => void;
};

type LangfuseTracingRuntime = {
    startObservation: (input: {
        name: string;
        input: string;
        metadata: Record<string, string>;
    }) => LangfuseObservationLike;
    shutdown: () => Promise<void>;
};

const createLangfuseTracingRuntime =
    async (): Promise<LangfuseTracingRuntime> => {
        const [{ LangfuseSpanProcessor }, { startObservation }, { NodeSDK }] =
            await Promise.all([
                import("@langfuse/otel"),
                import("@langfuse/tracing"),
                import("@opentelemetry/sdk-node"),
            ]);
        const sdk = new NodeSDK({
            serviceName: "reader-rag-evals",
            spanProcessors: [
                new LangfuseSpanProcessor({
                    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
                    secretKey: process.env.LANGFUSE_SECRET_KEY,
                    baseUrl: process.env.LANGFUSE_BASE_URL || undefined,
                    environment: process.env.NODE_ENV || "ci",
                }),
            ],
        });
        sdk.start();

        return {
            startObservation: ({ name, input, metadata }) => {
                const observation = startObservation(
                    name,
                    { input, metadata },
                    { asType: "chain" }
                );
                return observation;
            },
            shutdown: async () => {
                await sdk.shutdown();
            },
        };
    };

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
    clientPromise = createLangfuseClient(),
    tracingRuntimePromise?: Promise<LangfuseTracingRuntime>
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

    const answerCases = report.answers?.cases ?? [];
    const traceKey = (caseId: string, answerModel: string) =>
        `${caseId}:${answerModel}`;
    let tracingRuntime: LangfuseTracingRuntime | undefined;
    const observations = new Map<string, LangfuseObservationLike>();
    let syncedScores = 0;

    try {
        tracingRuntime = await (tracingRuntimePromise ??
            createLangfuseTracingRuntime());
        if (!client.score?.create) {
            throw new Error(
                "Installed Langfuse client does not support scores"
            );
        }
        const createScoreEvent = client.score.create.bind(client.score);
        for (const result of answerCases) {
            const observation = tracingRuntime.startObservation({
                name: "reader-rag-eval",
                input: result.question,
                metadata: {
                    runId: report.runId,
                    caseId: result.id,
                    answerModel: result.answerModel,
                    resolvedAnswerModel: result.resolvedAnswerModel,
                    judgeModel: result.judgeModel,
                    resolvedJudgeModel: result.resolvedJudgeModel,
                    reportResolvedAnswerModels:
                        report.resolvedAnswerModels.join(","),
                    reportResolvedJudgeModels:
                        report.resolvedJudgeModels.join(","),
                    pipelineVersions:
                        report.execution.pipelineVersions.join(","),
                    promptVersions: report.execution.promptVersions.join(","),
                    pricingVersion: report.execution.pricingVersion,
                    aggregateAnswerUsage:
                        report.execution.usage.answers === null
                            ? "unknown"
                            : JSON.stringify(report.execution.usage.answers),
                    aggregateJudgeUsage:
                        report.execution.usage.judge === null
                            ? "unknown"
                            : JSON.stringify(report.execution.usage.judge),
                    source: "packages/evals",
                },
            });
            observation.update({
                output: result.answer,
                metadata: {
                    generationDurationMs: result.generationDurationMs,
                    judgeDurationMs: result.judgeDurationMs,
                    answerUsage: result.answerUsage,
                    judgeUsage: result.judgeUsage,
                    answerEstimatedCost: result.answerEstimatedCost,
                    judgeEstimatedCost: result.judgeEstimatedCost,
                },
            });
            observations.set(
                traceKey(result.id, result.answerModel),
                observation
            );
        }

        const createScore = async (
            caseId: string,
            answerModel: string,
            name: string,
            value: number,
            traceId?: string,
            dataType: "NUMERIC" | "BOOLEAN" = "NUMERIC"
        ) => {
            if (!traceId) return;
            createScoreEvent({
                name,
                value,
                traceId,
                dataType,
                comment: `Reader RAG eval ${report.runId} case ${caseId} model ${answerModel}`,
                metadata: {
                    runId: report.runId,
                    caseId,
                    answerModel,
                    source: "packages/evals",
                },
            });
            syncedScores += 1;
        };

        for (const result of answerCases) {
            const traceId = observations.get(
                traceKey(result.id, result.answerModel)
            )?.traceId;
            await createScore(
                result.id,
                result.answerModel,
                "rag_eval_groundedness",
                result.scores.groundedness,
                traceId
            );
            await createScore(
                result.id,
                result.answerModel,
                "rag_eval_citation_coverage",
                result.scores.citationCoverage,
                traceId
            );
            await createScore(
                result.id,
                result.answerModel,
                "rag_eval_hallucination_rate",
                result.scores.hallucinationRate,
                traceId
            );
            await createScore(
                result.id,
                result.answerModel,
                "rag_eval_refusal_correctness",
                result.scores.refusalCorrectness,
                traceId
            );

            const retrieval = report.retrieval.cases.find(
                (candidate) => candidate.id === result.id
            );
            if (!retrieval) continue;
            await createScore(
                result.id,
                result.answerModel,
                "rag_eval_recall_at_k",
                retrieval.recallAtK,
                traceId
            );
            await createScore(
                result.id,
                result.answerModel,
                "rag_eval_reciprocal_rank",
                retrieval.reciprocalRank,
                traceId
            );
            await createScore(
                result.id,
                result.answerModel,
                "rag_eval_vector_reciprocal_rank",
                retrieval.vectorReciprocalRank,
                traceId
            );
            await createScore(
                result.id,
                result.answerModel,
                "rag_eval_vector_id_alignment",
                retrieval.vectorIdsAligned ? 1 : 0,
                traceId,
                "BOOLEAN"
            );
            if (retrieval.chapterCorrect !== null) {
                await createScore(
                    result.id,
                    result.answerModel,
                    "rag_eval_chapter_accuracy",
                    retrieval.chapterCorrect ? 1 : 0,
                    traceId,
                    "BOOLEAN"
                );
            }
        }
    } finally {
        for (const observation of observations.values()) observation.end();
        if (tracingRuntime) {
            try {
                await client.flush?.();
            } finally {
                await tracingRuntime.shutdown();
            }
        }
    }

    return { datasetName, syncedItems: cases.length, syncedScores };
};
