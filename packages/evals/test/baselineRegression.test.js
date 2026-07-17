const assert = require("node:assert/strict");
const test = require("node:test");

const {
    computeBaselineInputHashes,
    evaluateBaselineRegression,
    loadBaselineReference,
    validateBaselineReference,
} = require("../dist/baselineRegression");

const clone = (value) => structuredClone(value);

const observationFrom = (reference) => ({
    reference,
    datasetSha256: reference.datasetSha256,
    fixtureManifestSha256: reference.fixtureManifestSha256,
    pipelineVersions: [reference.pipelineVersion],
    promptVersions: [reference.promptVersion],
    answerModels: [...reference.answerModels],
    judgeModel: reference.judgeModel,
    retrieval: {
        summary: {
            caseCount: reference.requiredCaseIds.length,
            ...clone(reference.retrieval),
            perCategory: {},
            passed: false,
        },
        cases: reference.cases.map((snapshot) => ({
            ...clone(snapshot),
            fixtureId: "alice",
            suite: "required",
            category: snapshot.noAnswerExpected ? "no_answer" : "factual",
            question: snapshot.id,
            results: Array.from({ length: snapshot.sourceCount }, (_, index) => ({
                id: `${snapshot.id}-${index}`,
            })),
            expectedChunkIds: [],
            sourceHit: snapshot.recallAtK === 1,
            vectorSourceHit: snapshot.vectorReciprocalRank > 0,
            pipelineVersion: reference.pipelineVersion,
            promptVersion: reference.promptVersion,
            retrievalDurationMs: 1,
        })),
    },
    answers: {
        summary: {
            caseCount: reference.judgedAnswerCount,
            ...clone(reference.answers),
            perCategory: {},
            passed: false,
        },
        cases: Array.from({ length: reference.judgedAnswerCount }, (_, index) => ({
            id:
                index < reference.answerModels.length
                    ? "rabbit-pursuit-paraphrase"
                    : reference.requiredCaseIds[
                          index % reference.requiredCaseIds.length
                      ],
            passed: index >= reference.answerModels.length,
        })),
    },
});

test("loads the pinned baseline reference and verifies input hashes", async () => {
    const reference = await loadBaselineReference();
    const hashes = await computeBaselineInputHashes();

    assert.equal(reference.schemaVersion, 1);
    assert.equal(reference.requiredCaseIds.length, 7);
    assert.equal(hashes.datasetSha256, reference.datasetSha256);
    assert.equal(
        hashes.fixtureManifestSha256,
        reference.fixtureManifestSha256
    );
});

test("rejects invalid reference schemas, duplicate IDs, and unknown gaps", async () => {
    const reference = await loadBaselineReference();
    assert.throws(
        () => validateBaselineReference({ ...reference, schemaVersion: 2 }),
        /unsupported schema/
    );
    assert.throws(
        () =>
            validateBaselineReference({
                ...reference,
                requiredCaseIds: reference.requiredCaseIds.map((id, index) =>
                    index === 1 ? reference.requiredCaseIds[0] : id
                ),
            }),
        /seven unique/
    );
    assert.throws(
        () =>
            validateBaselineReference({
                ...reference,
                knownGaps: [
                    ...reference.knownGaps,
                    {
                        caseId: "unknown",
                        stages: ["retrieval"],
                        issue: 22,
                        description: "invalid",
                    },
                ],
            }),
        /known gaps/
    );
});

test("the exact baseline passes while preserving absolute quality misses", async () => {
    const reference = await loadBaselineReference();
    const result = evaluateBaselineRegression(observationFrom(reference));

    assert.equal(result.passed, true);
    assert.deepEqual(result.failedChecks, []);
    assert.deepEqual(result.improvements, []);
    assert.deepEqual(result.observedKnownGaps.sort(), [
        "no-answer-railway",
        "rabbit-pursuit-paraphrase",
    ]);
});

test("accepts known-gap improvements without rewriting the reference", async () => {
    const reference = await loadBaselineReference();
    const observation = observationFrom(reference);
    observation.retrieval.cases.find(
        (testCase) => testCase.id === "rabbit-pursuit-paraphrase"
    ).passed = true;
    for (const answer of observation.answers.cases) {
        if (answer.id === "rabbit-pursuit-paraphrase") answer.passed = true;
    }

    const result = evaluateBaselineRegression(observation);
    assert.equal(result.passed, true);
    assert.deepEqual(result.improvements, ["rabbit-pursuit-paraphrase"]);
});

test("fails aggregate, case-level, identity, and no-answer regressions", async () => {
    const reference = await loadBaselineReference();
    const observation = observationFrom(reference);
    observation.datasetSha256 = "0".repeat(64);
    observation.retrieval.summary.mrr -= 0.01;
    observation.retrieval.cases.find(
        (testCase) => testCase.id === "rabbit-watch"
    ).passed = false;
    observation.retrieval.cases.find(
        (testCase) => testCase.id === "no-answer-railway"
    ).results.push({ id: "extra" });

    const result = evaluateBaselineRegression(observation);
    assert.equal(result.passed, false);
    assert.ok(result.failedChecks.includes("datasetSha256Matches"));
    assert.ok(result.failedChecks.includes("mrrNonRegression"));
    assert.ok(
        result.failedChecks.includes(
            "case.rabbit-watch.previousPassPreserved"
        )
    );
    assert.ok(
        result.failedChecks.includes(
            "case.no-answer-railway.sourceCountNonIncrease"
        )
    );
});

test("enforces the five-point answer-quality budget inclusively", async () => {
    const reference = await loadBaselineReference();
    const boundary = observationFrom(reference);
    boundary.answers.summary.groundedness =
        reference.answers.groundedness - reference.answerMetricTolerance;
    boundary.answers.summary.hallucinationRate =
        reference.answers.hallucinationRate + reference.answerMetricTolerance;
    assert.equal(evaluateBaselineRegression(boundary).passed, true);

    const outside = observationFrom(reference);
    outside.answers.summary.groundedness =
        reference.answers.groundedness -
        reference.answerMetricTolerance -
        0.0001;
    outside.answers.summary.hallucinationRate =
        reference.answers.hallucinationRate +
        reference.answerMetricTolerance +
        0.0001;
    const result = evaluateBaselineRegression(outside);
    assert.equal(result.passed, false);
    assert.ok(result.failedChecks.includes("groundednessWithinBudget"));
    assert.ok(result.failedChecks.includes("hallucinationWithinBudget"));
});
