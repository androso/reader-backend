import assert from "node:assert/strict";
import test from "node:test";
import { buildJudgePrompt, runAnswerEval, type JudgeClient } from "../src";
import { getEvalThresholds } from "../src/config";
import { runRetrievalEval } from "../src/retrieval";
import type { RagEvalCase } from "../src/types";

const baseCase: RagEvalCase = {
    id: "case-1",
    question: "Who guards the gate?",
    collectionName: "book_test",
    chunks: [
        {
            id: "book_test_0",
            collectionName: "book_test",
            chunkIndex: 0,
            content: "Dragons guard the old mountain gate.",
            metadata: { chapterTitle: "Gate", chapterIndex: 0 },
        },
        {
            id: "book_test_1",
            collectionName: "book_test",
            chunkIndex: 1,
            content: "A library holds maps.",
            metadata: { chapterTitle: "Library", chapterIndex: 1 },
        },
    ],
    expectedChunkIds: ["book_test_0"],
    expectedAnswer: "Dragons guard the old mountain gate.",
    candidateAnswer: "Dragons guard the old mountain gate.",
    expectedChapterTitle: "Gate",
};

test("retrieval eval scores exact chunk and chapter hits", async () => {
    const result = await runRetrievalEval([baseCase], getEvalThresholds());

    assert.equal(result.cases[0].sourceHit, true);
    assert.equal(result.cases[0].chapterCorrect, true);
    assert.equal(result.summary.passed, true);
});

test("judge prompt includes source ids and answer", () => {
    const prompt = buildJudgePrompt(baseCase);

    assert.match(prompt, /book_test_0/);
    assert.match(prompt, /Dragons guard the old mountain gate/);
});

test("answer eval applies judge thresholds", async () => {
    const judge: JudgeClient = {
        score: async () => ({
            groundedness: 1,
            citationCoverage: 1,
            refusalCorrectness: 1,
            hallucinationRate: 0,
            rationale: "Grounded in the provided source.",
        }),
    };

    const result = await runAnswerEval([baseCase], getEvalThresholds(), judge);

    assert.equal(result.summary.passed, true);
    assert.equal(result.cases[0].passed, true);
});
