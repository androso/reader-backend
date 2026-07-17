export const RAG_PIPELINES = {
    "baseline-rag-v1": {
        pipelineVersion: "baseline-rag-v1",
        promptVersion: "book-context-v1",
    },
} as const;

export type RagPipelineVersion = keyof typeof RAG_PIPELINES;
export type RagPromptVersion =
    (typeof RAG_PIPELINES)[RagPipelineVersion]["promptVersion"];

export const DEFAULT_RAG_PIPELINE_VERSION: RagPipelineVersion =
    "baseline-rag-v1";

export const getRagPipeline = () => {
    const configured =
        process.env.RAG_PIPELINE_VERSION || DEFAULT_RAG_PIPELINE_VERSION;
    if (!Object.prototype.hasOwnProperty.call(RAG_PIPELINES, configured)) {
        throw new Error(`Unsupported RAG pipeline version: ${configured}`);
    }

    return RAG_PIPELINES[configured as RagPipelineVersion];
};
