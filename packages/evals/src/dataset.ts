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
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RagEvalCase);
};
