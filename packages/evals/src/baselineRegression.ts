import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
    AnswerSummary,
    BaselineRegressionReference,
    BaselineRegressionResult,
    RetrievalCaseResult,
    RetrievalSummary,
} from "./types";

const BASELINE_PATH = path.resolve(
    __dirname,
    "../baselines/baseline-rag-v1.json"
);
const DATASET_PATH = path.resolve(
    __dirname,
    "../datasets/reader-rag-golden.jsonl"
);
const FIXTURE_MANIFEST_PATH = path.resolve(
    __dirname,
    "../fixtures/manifest.json"
);
const EPSILON = 1e-12;

const sha256 = (value: Buffer | string) =>
    createHash("sha256").update(value).digest("hex");

const unique = (values: string[]) => new Set(values).size === values.length;

const assertUnitMetric = (name: string, value: unknown) => {
    if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1
    ) {
        throw new Error(`Baseline reference ${name} must be between 0 and 1`);
    }
};

export const validateBaselineReference = (
    value: unknown
): BaselineRegressionReference => {
    if (!value || typeof value !== "object") {
        throw new Error("Baseline reference must be an object");
    }
    const reference = value as BaselineRegressionReference;
    if (reference.schemaVersion !== 1) {
        throw new Error("Baseline reference has an unsupported schema version");
    }
    if (
        !reference.referenceVersion ||
        !reference.pipelineVersion ||
        !reference.promptVersion
    ) {
        throw new Error("Baseline reference identity is incomplete");
    }
    if (!/^[a-f0-9]{64}$/.test(reference.datasetSha256)) {
        throw new Error("Baseline reference dataset SHA-256 is invalid");
    }
    if (!/^[a-f0-9]{64}$/.test(reference.fixtureManifestSha256)) {
        throw new Error("Baseline reference fixture SHA-256 is invalid");
    }
    if (
        !Array.isArray(reference.requiredCaseIds) ||
        reference.requiredCaseIds.length !== 7 ||
        !unique(reference.requiredCaseIds)
    ) {
        throw new Error(
            "Baseline reference must contain seven unique required case IDs"
        );
    }
    if (
        !Array.isArray(reference.answerModels) ||
        reference.answerModels.length !== 3 ||
        !unique(reference.answerModels)
    ) {
        throw new Error("Baseline reference must contain three answer models");
    }
    if (reference.judgedAnswerCount !== 21) {
        throw new Error("Baseline reference must require 21 judged answers");
    }
    assertUnitMetric(
        "answerMetricTolerance",
        reference.answerMetricTolerance
    );
    for (const [name, metric] of Object.entries(reference.retrieval)) {
        if (metric !== null) assertUnitMetric(`retrieval.${name}`, metric);
    }
    for (const [name, metric] of Object.entries(reference.answers)) {
        assertUnitMetric(`answers.${name}`, metric);
    }
    if (
        !Array.isArray(reference.cases) ||
        reference.cases.length !== reference.requiredCaseIds.length ||
        !unique(reference.cases.map((testCase) => testCase.id)) ||
        !reference.requiredCaseIds.every((id) =>
            reference.cases.some((testCase) => testCase.id === id)
        )
    ) {
        throw new Error("Baseline reference case snapshots do not match IDs");
    }
    if (
        !Array.isArray(reference.knownGaps) ||
        !unique(reference.knownGaps.map((gap) => gap.caseId)) ||
        !reference.knownGaps.every((gap) =>
            reference.requiredCaseIds.includes(gap.caseId)
        )
    ) {
        throw new Error("Baseline reference known gaps are invalid");
    }
    return reference;
};

export const loadBaselineReference = async (
    filePath = BASELINE_PATH
): Promise<BaselineRegressionReference> =>
    validateBaselineReference(JSON.parse(await fs.readFile(filePath, "utf8")));

export const computeBaselineInputHashes = async ({
    datasetPath = DATASET_PATH,
    fixtureManifestPath = FIXTURE_MANIFEST_PATH,
}: {
    datasetPath?: string;
    fixtureManifestPath?: string;
} = {}) => ({
    datasetSha256: sha256(await fs.readFile(datasetPath)),
    fixtureManifestSha256: sha256(await fs.readFile(fixtureManifestPath)),
});

const equalSets = (left: string[], right: string[]) =>
    left.length === right.length &&
    left.every((value) => right.includes(value));

const atLeast = (actual: number, expected: number) =>
    actual + EPSILON >= expected;
const atMost = (actual: number, expected: number) =>
    actual <= expected + EPSILON;

export const evaluateBaselineRegression = ({
    reference,
    datasetSha256,
    fixtureManifestSha256,
    pipelineVersions,
    promptVersions,
    answerModels,
    judgeModel,
    retrieval,
    answers,
}: {
    reference: BaselineRegressionReference;
    datasetSha256: string;
    fixtureManifestSha256: string;
    pipelineVersions: string[];
    promptVersions: string[];
    answerModels: string[];
    judgeModel: string;
    retrieval: { summary: RetrievalSummary; cases: RetrievalCaseResult[] };
    answers: { summary: AnswerSummary; cases: unknown[] };
}): BaselineRegressionResult => {
    const checks: Record<string, boolean> = {
        datasetSha256Matches: datasetSha256 === reference.datasetSha256,
        fixtureManifestSha256Matches:
            fixtureManifestSha256 === reference.fixtureManifestSha256,
        pipelineMatches:
            pipelineVersions.length === 1 &&
            pipelineVersions[0] === reference.pipelineVersion,
        promptMatches:
            promptVersions.length === 1 &&
            promptVersions[0] === reference.promptVersion,
        answerModelsMatch: equalSets(answerModels, reference.answerModels),
        judgeModelMatches: judgeModel === reference.judgeModel,
        judgedAnswerCountMatches:
            answers.cases.length === reference.judgedAnswerCount,
        requiredCasesMatch: equalSets(
            retrieval.cases.map((testCase) => testCase.id),
            reference.requiredCaseIds
        ),
        recallAtKNonRegression: atLeast(
            retrieval.summary.recallAtK,
            reference.retrieval.recallAtK
        ),
        evidenceCoverageNonRegression: atLeast(
            retrieval.summary.evidenceCoverage,
            reference.retrieval.evidenceCoverage
        ),
        mrrNonRegression: atLeast(
            retrieval.summary.mrr,
            reference.retrieval.mrr
        ),
        sourceHitRateNonRegression: atLeast(
            retrieval.summary.sourceHitRate,
            reference.retrieval.sourceHitRate
        ),
        vectorSourceHitRateNonRegression: atLeast(
            retrieval.summary.vectorSourceHitRate,
            reference.retrieval.vectorSourceHitRate
        ),
        vectorMrrNonRegression: atLeast(
            retrieval.summary.vectorMrr,
            reference.retrieval.vectorMrr
        ),
        vectorIdAlignmentRateNonRegression: atLeast(
            retrieval.summary.vectorIdAlignmentRate,
            reference.retrieval.vectorIdAlignmentRate
        ),
        chunkWindowHitRateNonRegression: atLeast(
            retrieval.summary.chunkWindowHitRate,
            reference.retrieval.chunkWindowHitRate
        ),
        chapterAccuracyNonRegression:
            retrieval.summary.chapterAccuracy !== null &&
            reference.retrieval.chapterAccuracy !== null &&
            atLeast(
                retrieval.summary.chapterAccuracy,
                reference.retrieval.chapterAccuracy
            ),
        groundednessWithinBudget: atLeast(
            answers.summary.groundedness,
            reference.answers.groundedness - reference.answerMetricTolerance
        ),
        citationCoverageWithinBudget: atLeast(
            answers.summary.citationCoverage,
            reference.answers.citationCoverage -
                reference.answerMetricTolerance
        ),
        refusalCorrectnessWithinBudget: atLeast(
            answers.summary.refusalCorrectness,
            reference.answers.refusalCorrectness -
                reference.answerMetricTolerance
        ),
        hallucinationWithinBudget: atMost(
            answers.summary.hallucinationRate,
            reference.answers.hallucinationRate +
                reference.answerMetricTolerance
        ),
    };

    for (const expected of reference.cases) {
        const actual = retrieval.cases.find(
            (testCase) => testCase.id === expected.id
        );
        const prefix = `case.${expected.id}`;
        checks[`${prefix}.present`] = Boolean(actual);
        if (!actual) continue;
        checks[`${prefix}.vectorIdsAligned`] = actual.vectorIdsAligned;
        if (expected.passed) {
            checks[`${prefix}.previousPassPreserved`] = actual.passed;
        }
        if (expected.noAnswerExpected) {
            checks[`${prefix}.sourceCountNonIncrease`] =
                actual.results.length <= expected.sourceCount;
        } else {
            checks[`${prefix}.recallNonRegression`] = atLeast(
                actual.recallAtK,
                expected.recallAtK
            );
            checks[`${prefix}.coverageNonRegression`] = atLeast(
                actual.evidenceCoverage,
                expected.evidenceCoverage
            );
            checks[`${prefix}.rankNonRegression`] = atLeast(
                actual.reciprocalRank,
                expected.reciprocalRank
            );
            checks[`${prefix}.vectorRankNonRegression`] = atLeast(
                actual.vectorReciprocalRank,
                expected.vectorReciprocalRank
            );
            checks[`${prefix}.chunkWindowNonRegression`] =
                !expected.chunkWindowHit || actual.chunkWindowHit;
            checks[`${prefix}.chapterNonRegression`] =
                expected.chapterCorrect !== true ||
                actual.chapterCorrect === true;
        }
    }

    const observedKnownGaps = reference.knownGaps
        .filter((gap) => {
            const retrievalCase = retrieval.cases.find(
                (testCase) => testCase.id === gap.caseId
            );
            const answerCases = answers.cases as Array<{
                id?: string;
                passed?: boolean;
            }>;
            return (
                (gap.stages.includes("retrieval") &&
                    retrievalCase?.passed === false) ||
                (gap.stages.includes("answer") &&
                    answerCases.some(
                        (testCase) =>
                            testCase.id === gap.caseId && !testCase.passed
                    ))
            );
        })
        .map((gap) => gap.caseId);
    const improvements = reference.knownGaps
        .filter((gap) => !observedKnownGaps.includes(gap.caseId))
        .map((gap) => gap.caseId);
    const failedChecks = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);

    return {
        referenceVersion: reference.referenceVersion,
        pipelineVersion: reference.pipelineVersion,
        datasetSha256,
        fixtureManifestSha256,
        passed: failedChecks.length === 0,
        checks,
        failedChecks,
        improvements,
        observedKnownGaps,
    };
};
