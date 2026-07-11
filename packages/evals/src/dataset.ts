import fs from "node:fs/promises";
import path from "node:path";
import type { RagEvalCase } from "./types";

const DATASET_PATH = path.resolve(
    __dirname,
    "../datasets/reader-rag-golden.jsonl"
);

export const loadGoldenDataset = async (
    datasetPath = DATASET_PATH
): Promise<RagEvalCase[]> => {
    const raw = await fs.readFile(datasetPath, "utf8");
    const cases = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
            let value: unknown;
            try {
                value = JSON.parse(line);
            } catch {
                throw new Error(`Invalid JSON on dataset line ${index + 1}`);
            }
            if (!value || typeof value !== "object") {
                throw new Error(`Dataset line ${index + 1} must be an object`);
            }
            const testCase = value as Partial<RagEvalCase>;
            for (const field of ["id", "question", "expectedAnswer"] as const) {
                if (
                    typeof testCase[field] !== "string" ||
                    !testCase[field]!.trim()
                ) {
                    throw new Error(
                        `Dataset line ${index + 1} requires ${field}`
                    );
                }
            }
            if (
                !testCase.noAnswerExpected &&
                !testCase.expectedEvidenceText &&
                !testCase.expectedChapterTitle
            ) {
                throw new Error(
                    `Answerable dataset case ${testCase.id} requires expected evidence or chapter`
                );
            }
            return testCase as RagEvalCase;
        });

    const ids = new Set<string>();
    for (const testCase of cases) {
        if (ids.has(testCase.id)) {
            throw new Error(`Duplicate dataset case id: ${testCase.id}`);
        }
        ids.add(testCase.id);
    }
    if (!cases.length) throw new Error("RAG eval dataset is empty");
    return cases;
};
