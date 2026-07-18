export const RAG_PIPELINES = {
    "baseline-rag-v1": {
        pipelineVersion: "baseline-rag-v1",
        retrievalStrategy: "baseline",
        promptVersion: "book-context-v1",
        answerPromptVersion: "book-context-v1",
        rerankerPromptVersion: null,
        rerankerModel: null,
    },
    "rerank-rag-v1": {
        pipelineVersion: "rerank-rag-v1",
        retrievalStrategy: "reranked",
        promptVersion: "book-context-v1",
        answerPromptVersion: "book-context-v1",
        rerankerPromptVersion: "rerank-documents-v1",
        rerankerModel: "gpt-5.4-mini-2026-03-17",
    },
} as const;

export const RERANKER_MODELS = {
    "gpt-5.4-mini-2026-03-17": "gpt-5.4-mini-2026-03-17",
} as const;

export type RagPipelineVersion = keyof typeof RAG_PIPELINES;
export type RagPromptVersion =
    (typeof RAG_PIPELINES)[RagPipelineVersion]["promptVersion"];
export type RagRetrievalStrategy =
    (typeof RAG_PIPELINES)[RagPipelineVersion]["retrievalStrategy"];

export const DEFAULT_RAG_PIPELINE_VERSION: RagPipelineVersion =
    "baseline-rag-v1";

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
