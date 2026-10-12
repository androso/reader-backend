import {
    DEFAULT_RAG_PIPELINE_VERSION,
    RAG_PIPELINES,
    RERANKER_MODELS,
    type RagPipelineVersion,
} from "@reader/domain";
import type { RagConfiguration } from "@reader/application";

export {
    DEFAULT_RAG_PIPELINE_VERSION,
    RAG_PIPELINES,
    RERANKER_MODELS,
    type RagPipelineVersion,
};
export type RagPromptVersion =
    (typeof RAG_PIPELINES)[RagPipelineVersion]["promptVersion"];
export type RagRetrievalStrategy =
    (typeof RAG_PIPELINES)[RagPipelineVersion]["retrievalStrategy"];

export const DEFAULT_RAG_MIN_HYBRID_SCORE = 0.03;

export const getRerankerModel = () => {
    const configured =
        process.env.RAG_RERANKER_MODEL || "gpt-5.4-mini-2026-03-17";
    if (!Object.prototype.hasOwnProperty.call(RERANKER_MODELS, configured)) {
        throw new Error(`Unsupported RAG reranker model: ${configured}`);
    }
    return RERANKER_MODELS[configured as keyof typeof RERANKER_MODELS];
};

export const getRagPipeline = (pipelineVersion?: RagPipelineVersion) => {
    const configured =
        pipelineVersion ||
        process.env.RAG_PIPELINE_VERSION ||
        DEFAULT_RAG_PIPELINE_VERSION;
    if (!Object.prototype.hasOwnProperty.call(RAG_PIPELINES, configured)) {
        throw new Error(`Unsupported RAG pipeline version: ${configured}`);
    }

    const pipeline = RAG_PIPELINES[configured as RagPipelineVersion];
    if (pipeline.retrievalStrategy === "reranked") getRerankerModel();
    return pipeline;
};

export const getRagMinHybridScore = () => {
    const configured = Number(process.env.RAG_MIN_HYBRID_SCORE);
    return Number.isFinite(configured)
        ? configured
        : DEFAULT_RAG_MIN_HYBRID_SCORE;
};

export const ragConfiguration: RagConfiguration = {
    getPipeline: getRagPipeline,
    getMinHybridScore: getRagMinHybridScore,
};
