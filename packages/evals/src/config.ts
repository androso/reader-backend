import type { EvalSuite, EvalThresholds } from "./types";

export const DEFAULT_JUDGE_MODEL = "gpt-5.4-mini-2026-03-17";
export const DEFAULT_DATASET_NAME = "reader/rag-golden";

const unitIntervalEnv = (name: string, fallback: number) => {
    const parsed = Number(process.env[name]);
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed < 0 || parsed > 1) {
        throw new Error(`${name} must be between 0 and 1`);
    }
    return parsed;
};

const integerEnv = (name: string, fallback: number) => {
    const parsed = Number(process.env[name]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const getEvalThresholds = (): EvalThresholds => ({
    minRecallAtK: unitIntervalEnv("RAG_EVAL_MIN_RECALL_AT_K", 0.75),
    minMrr: unitIntervalEnv("RAG_EVAL_MIN_MRR", 0.7),
    minSourceHitRate: unitIntervalEnv("RAG_EVAL_MIN_SOURCE_HIT_RATE", 0.75),
    minChunkWindowHitRate: unitIntervalEnv(
        "RAG_EVAL_MIN_CHUNK_WINDOW_HIT_RATE",
        0.75
    ),
    minGroundedness: unitIntervalEnv("RAG_EVAL_MIN_GROUNDEDNESS", 0.8),
    minCitationCoverage: unitIntervalEnv("RAG_EVAL_MIN_CITATION_COVERAGE", 0.8),
    minRefusalCorrectness: unitIntervalEnv(
        "RAG_EVAL_MIN_REFUSAL_CORRECTNESS",
        0.8
    ),
    maxHallucinationRate: unitIntervalEnv(
        "RAG_EVAL_MAX_HALLUCINATION_RATE",
        0.2
    ),
});

export const getJudgeModel = () =>
    process.env.RAG_EVAL_JUDGE_MODEL || DEFAULT_JUDGE_MODEL;

export const getJudgeMaxCases = () =>
    integerEnv("RAG_EVAL_JUDGE_MAX_CASES", 25);

export const getLangfuseDatasetName = () =>
    process.env.RAG_EVAL_LANGFUSE_DATASET || DEFAULT_DATASET_NAME;

export const hasOpenAiConfig = () => Boolean(process.env.OPENAI_API_KEY);

export const hasLangfuseConfig = () =>
    Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

export const shouldFailQualityGate = (
    suite: EvalSuite,
    qualityPassed: boolean
) => suite === "required" && !qualityPassed;
