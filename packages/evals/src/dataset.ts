import fs from "node:fs/promises";
import path from "node:path";
import type {
    EvalCategory,
    EvalSuite,
    ExpectedEvidenceAnchor,
    RagEvalCase,
} from "./types";

const DATASET_PATH = path.resolve(
    __dirname,
    "../datasets/reader-rag-golden.jsonl"
);

const SUITES = new Set<EvalSuite>(["required", "extended"]);
const CATEGORIES = new Set<EvalCategory>([
    "factual",
    "paraphrase",
    "no_answer",
    "follow_up",
    "highlight",
    "summary",
    "comparison",
    "adversarial",
    "isolation",
]);

const validateEvidence = (
    value: unknown,
    caseId: string
): ExpectedEvidenceAnchor[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.length) {
        throw new Error(
            `Answerable dataset case ${caseId} requires expectedEvidence`
        );
    }
    return value.map((anchor, index) => {
        if (
            !anchor ||
            typeof anchor !== "object" ||
            typeof (anchor as ExpectedEvidenceAnchor).text !== "string" ||
            !(anchor as ExpectedEvidenceAnchor).text.trim()
        ) {
            throw new Error(
                `Dataset case ${caseId} evidence ${index + 1} requires text`
            );
        }
        const chapterTitle = (anchor as ExpectedEvidenceAnchor).chapterTitle;
        if (
            chapterTitle !== undefined &&
            (typeof chapterTitle !== "string" || !chapterTitle.trim())
        ) {
            throw new Error(
                `Dataset case ${caseId} evidence ${index + 1} has invalid chapterTitle`
            );
        }
        return anchor as ExpectedEvidenceAnchor;
    });
};

const validateMessages = (value: unknown, caseId: string) => {
    if (value === undefined) return undefined;
    if (
        !Array.isArray(value) ||
        value.some(
            (message) =>
                !message ||
                typeof message !== "object" ||
                !["system", "user", "assistant"].includes(
                    String((message as { role?: unknown }).role)
                ) ||
                typeof (message as { content?: unknown }).content !== "string"
        )
    ) {
        throw new Error(`Dataset case ${caseId} has invalid priorMessages`);
    }
    return value as RagEvalCase["priorMessages"];
};

export const selectDatasetCases = (cases: RagEvalCase[], suite: EvalSuite) =>
    suite === "required"
        ? cases.filter((testCase) => testCase.suite === "required")
        : cases;

export const loadGoldenDataset = async (
    datasetPath = DATASET_PATH,
    suite: EvalSuite = "required"
): Promise<RagEvalCase[]> => {
    if (!SUITES.has(suite)) throw new Error(`Invalid eval suite: ${suite}`);
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
            for (const field of [
                "id",
                "fixtureId",
                "question",
                "expectedAnswer",
            ] as const) {
                if (
                    typeof testCase[field] !== "string" ||
                    !testCase[field]!.trim()
                ) {
                    throw new Error(
                        `Dataset line ${index + 1} requires ${field}`
                    );
                }
            }
            if (!SUITES.has(testCase.suite as EvalSuite)) {
                throw new Error(`Dataset line ${index + 1} has invalid suite`);
            }
            if (!CATEGORIES.has(testCase.category as EvalCategory)) {
                throw new Error(
                    `Dataset line ${index + 1} has invalid category`
                );
            }
            testCase.expectedEvidence = validateEvidence(
                testCase.expectedEvidence,
                testCase.id!
            );
            testCase.priorMessages = validateMessages(
                testCase.priorMessages,
                testCase.id!
            );
            if (testCase.highlightContext !== undefined) {
                if (
                    !testCase.highlightContext ||
                    testCase.highlightContext.sourceType !== "epub" ||
                    typeof testCase.highlightContext.text !== "string" ||
                    !testCase.highlightContext.text.trim()
                ) {
                    throw new Error(
                        `Dataset case ${testCase.id} has invalid highlightContext`
                    );
                }
            }
            if (
                !testCase.noAnswerExpected &&
                !testCase.expectedEvidence?.length
            ) {
                throw new Error(
                    `Answerable dataset case ${testCase.id} requires expectedEvidence`
                );
            }
            if (
                testCase.noAnswerExpected &&
                testCase.category !== "no_answer"
            ) {
                throw new Error(
                    `No-answer dataset case ${testCase.id} must use category no_answer`
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
    const selected = selectDatasetCases(cases, suite);
    if (!selected.length) {
        throw new Error(`RAG eval ${suite} suite is empty`);
    }
    return selected;
};
