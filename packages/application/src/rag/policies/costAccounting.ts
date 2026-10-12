import type {
    RagModelCost,
    RagModelUsage,
    RagRetrievalDiagnostics,
} from "@reader/domain";

export type NormalizedModelUsage = RagModelUsage;

export interface ModelPrice {
    inputUsdPerMillion: number;
    cachedInputUsdPerMillion: number;
    outputUsdPerMillion: number;
    sourceUrl: string;
}

export interface EstimatedModelCost extends RagModelCost {
    pricingVersion: typeof AI_PRICING_VERSION;
}

export const AI_PRICING_VERSION = "openai-standard-2026-07-16" as const;

export const OPENAI_PRICES: Record<string, ModelPrice> = {
    "gpt-4o-mini": {
        inputUsdPerMillion: 0.15,
        cachedInputUsdPerMillion: 0.075,
        outputUsdPerMillion: 0.6,
        sourceUrl: "https://developers.openai.com/api/docs/models/gpt-4o-mini",
    },
    "gpt-4o-mini-2024-07-18": {
        inputUsdPerMillion: 0.15,
        cachedInputUsdPerMillion: 0.075,
        outputUsdPerMillion: 0.6,
        sourceUrl: "https://developers.openai.com/api/docs/models/gpt-4o-mini",
    },
    "gpt-5.4-mini-2026-03-17": {
        inputUsdPerMillion: 0.75,
        cachedInputUsdPerMillion: 0.075,
        outputUsdPerMillion: 4.5,
        sourceUrl:
            "https://openai.com/index/introducing-gpt-5-4-mini-and-nano/",
    },
    "gpt-5.5-2026-04-23": {
        inputUsdPerMillion: 5,
        cachedInputUsdPerMillion: 0.5,
        outputUsdPerMillion: 30,
        sourceUrl: "https://openai.com/index/introducing-gpt-5-5/",
    },
};

const nonNegativeInteger = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

export const normalizeModelUsage = (
    usage: unknown
): NormalizedModelUsage | null => {
    if (!usage || typeof usage !== "object") return null;

    const candidate = usage as {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        input_tokens?: unknown;
        output_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown };
        input_tokens_details?: { cached_tokens?: unknown };
    };
    const inputTokens = nonNegativeInteger(
        candidate.prompt_tokens ?? candidate.input_tokens
    );
    const outputTokens = nonNegativeInteger(
        candidate.completion_tokens ?? candidate.output_tokens
    );
    const cachedInputTokens = Math.min(
        inputTokens,
        nonNegativeInteger(
            candidate.prompt_tokens_details?.cached_tokens ??
                candidate.input_tokens_details?.cached_tokens
        )
    );
    const totalTokens = nonNegativeInteger(candidate.total_tokens);

    if (!inputTokens && !outputTokens && !totalTokens) return null;

    return {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens: totalTokens || inputTokens + outputTokens,
    };
};

export const estimateModelCost = (
    model: string,
    usage: NormalizedModelUsage | null
): EstimatedModelCost | null => {
    const price = OPENAI_PRICES[model];
    if (!price || !usage) return null;

    const uncachedInputTokens = Math.max(
        0,
        usage.inputTokens - usage.cachedInputTokens
    );
    const amount =
        (uncachedInputTokens * price.inputUsdPerMillion +
            usage.cachedInputTokens * price.cachedInputUsdPerMillion +
            usage.outputTokens * price.outputUsdPerMillion) /
        1_000_000;

    return {
        currency: "USD",
        amount,
        pricingVersion: AI_PRICING_VERSION,
        sourceUrl: price.sourceUrl,
    };
};

export const calculateChatExecutionCosts = ({
    model,
    usage,
    retrieval,
}: {
    model: string;
    usage: unknown;
    retrieval: RagRetrievalDiagnostics | null;
}) => {
    const normalizedUsage = normalizeModelUsage(usage);
    const generationCost = estimateModelCost(model, normalizedUsage);
    const retrievalCost =
        retrieval?.mode === "reranked"
            ? retrieval.reranker.estimatedCost
            : null;
    const retrievalCostKnownZero =
        retrieval?.mode === "reranked" &&
        retrieval.reranker.status === "skipped";
    const combinedCost =
        generationCost &&
        (retrieval?.mode !== "reranked" ||
            retrievalCost ||
            retrievalCostKnownZero)
            ? {
                  currency: "USD" as const,
                  amount: generationCost.amount + (retrievalCost?.amount ?? 0),
                  pricingVersion: AI_PRICING_VERSION,
              }
            : null;

    return {
        pricingVersion: AI_PRICING_VERSION,
        normalizedUsage,
        generationCost,
        retrievalCost,
        combinedCost,
    };
};
