const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { getEvalThresholds } = require("../dist/config");
const { loadGoldenDataset } = require("../dist/dataset");
const { scoreRetrievalEval } = require("../dist/retrieval");
const { runAnswerEval } = require("../dist/answerJudge");

const thresholds = {
    minRecallAtK: 0.75,
    minMrr: 0.7,
    minSourceHitRate: 0.75,
    minChunkWindowHitRate: 0.75,
    minGroundedness: 0.8,
    minCitationCoverage: 0.8,
    minRefusalCorrectness: 0.8,
    maxHallucinationRate: 0.2,
};

test("negative retrieval cases are not reported as source hits", () => {
    const result = scoreRetrievalEval(
        [
            {
                id: "negative",
                question: "unsupported",
                expectedAnswer: "not provided",
                noAnswerExpected: true,
                candidateAnswer: "not provided",
                sources: [
                    { id: "chunk_1", chunkIndex: 1, content: "irrelevant" },
                ],
                vectorResultIds: ["chunk_1"],
                vectorIdsAligned: true,
            },
        ],
        thresholds
    );

    assert.equal(result.cases[0].sourceHit, false);
    assert.equal(result.cases[0].vectorSourceHit, false);
    assert.equal(result.cases[0].chunkWindowHit, false);
});

test("thresholds reject values outside the unit interval", () => {
    const previous = process.env.RAG_EVAL_MIN_RECALL_AT_K;
    process.env.RAG_EVAL_MIN_RECALL_AT_K = "-1";
    try {
        assert.throws(getEvalThresholds, /must be between 0 and 1/);
    } finally {
        if (previous === undefined) delete process.env.RAG_EVAL_MIN_RECALL_AT_K;
        else process.env.RAG_EVAL_MIN_RECALL_AT_K = previous;
    }
});

test("correct refusals do not require supporting citations", async () => {
    const result = await runAnswerEval(
        [
            {
                id: "negative",
                question: "unsupported",
                expectedAnswer: "not provided",
                noAnswerExpected: true,
                candidateAnswer: "The book does not say.",
                sources: [],
                vectorResultIds: [],
                vectorIdsAligned: true,
            },
        ],
        thresholds,
        {
            async score() {
                return {
                    groundedness: 1,
                    citationCoverage: 0,
                    refusalCorrectness: 1,
                    hallucinationRate: 0,
                    rationale: "Correct refusal",
                };
            },
        }
    );

    assert.equal(result.cases[0].passed, true);
    assert.equal(result.summary.passed, true);
});

test("dataset validation rejects duplicate IDs", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-evals-"));
    const datasetPath = path.join(directory, "dataset.jsonl");
    const row = JSON.stringify({
        id: "duplicate",
        question: "question",
        expectedAnswer: "answer",
        expectedEvidenceText: "evidence",
    });
    await fs.writeFile(datasetPath, `${row}\n${row}\n`);

    await assert.rejects(
        loadGoldenDataset(datasetPath),
        /Duplicate dataset case id/
    );
});
