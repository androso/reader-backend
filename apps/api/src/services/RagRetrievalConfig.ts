export const DEFAULT_RAG_MIN_HYBRID_SCORE = 0.03;

export const getRagMinHybridScore = () => {
    const configured = Number(process.env.RAG_MIN_HYBRID_SCORE);
    return Number.isFinite(configured)
        ? configured
        : DEFAULT_RAG_MIN_HYBRID_SCORE;
};
