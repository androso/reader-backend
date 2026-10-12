import type { RagShadowResult, RagShadowSourceRank } from "@reader/domain";
import type { Clock } from "./ports";
import type {
    RagShadowJob,
    RagShadowRecords,
    RagShadowTracing,
    ShadowRepository,
} from "./ports";
import type { RagTracing } from "./ports";
import {
    RetrieveBookEvidence,
    type RetrieveBookEvidenceInput,
} from "./RetrieveBookEvidence";
import { compareShadowSourceRanks } from "./policies/shadowComparison";

export class RagShadowAuthorizationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RagShadowAuthorizationError";
    }
}

export const validateRagShadowRecords = (
    payload: RagShadowJob,
    records: RagShadowRecords
) => {
    if (
        !records.assistant ||
        !records.userMessage ||
        !records.conversation ||
        !records.book
    ) {
        return "missing" as const;
    }
    if (
        records.assistant.role !== "assistant" ||
        records.userMessage.role !== "user" ||
        records.assistant.id !== payload.assistantMessageId ||
        records.userMessage.id !== payload.userMessageId ||
        records.assistant.conversationId !== payload.conversationId ||
        records.userMessage.conversationId !== payload.conversationId ||
        records.conversation.id !== payload.conversationId ||
        records.conversation.userId !== payload.userId ||
        records.conversation.resourceType !== "book" ||
        records.conversation.resourceId !== payload.bookId ||
        records.book.id !== payload.bookId ||
        records.book.userId !== payload.userId
    ) {
        throw new RagShadowAuthorizationError(
            "Shadow job identifiers do not share one authorized book conversation"
        );
    }
    if (records.assistant.executionMetadata?.shadow) {
        return "already_completed" as const;
    }
    if (!records.assistant.executionMetadata) {
        throw new Error(
            "Assistant message is missing baseline execution metadata"
        );
    }
    if (
        records.assistant.executionMetadata.pipelineVersion !==
        "baseline-rag-v1"
    ) {
        return "not_baseline" as const;
    }
    return "authorized" as const;
};

const sourceRanks = (
    sources: Array<Pick<{ id: string }, "id">> | null | undefined
): RagShadowSourceRank[] =>
    (sources ?? []).map((source, index) => ({
        id: source.id,
        rank: index + 1,
    }));

export interface ProcessRagShadowComparisonDependencies {
    repository: ShadowRepository;
    retrieval: Pick<RetrieveBookEvidence, "execute">;
    tracing: RagShadowTracing;
    clock: Clock;
}

export interface ProcessRagShadowComparisonInput {
    payload: RagShadowJob;
    trace?: RagTracing;
}

export class ProcessRagShadowComparison {
    constructor(
        private readonly deps: ProcessRagShadowComparisonDependencies
    ) {}

    async execute(input: ProcessRagShadowComparisonInput) {
        const records = await this.deps.repository.load(input.payload);
        const validation = validateRagShadowRecords(input.payload, records);
        if (validation !== "authorized") {
            return { status: validation } as const;
        }

        const baselineMetadata = records.assistant!.executionMetadata!;
        const baselineTraceId =
            typeof baselineMetadata.langfuseTraceId === "string"
                ? baselineMetadata.langfuseTraceId
                : null;

        return this.deps.tracing.withShadowTrace(
            {
                userId: input.payload.userId,
                conversationId: input.payload.conversationId,
                bookId: input.payload.bookId,
                assistantMessageId: input.payload.assistantMessageId,
                baselineTraceId,
            },
            async (shadowTrace) => {
                const activeTrace = input.trace?.traceId
                    ? input.trace
                    : shadowTrace;
                const retrievalTrace =
                    this.deps.tracing.contentFree(activeTrace);
                const evidenceInput: RetrieveBookEvidenceInput = {
                    bookId: input.payload.bookId,
                    userId: input.payload.userId,
                    query: records.userMessage!.content,
                    trace: retrievalTrace,
                    strict: true,
                    pipelineVersion: "rerank-rag-v1",
                    includeErrorDetailInLogs: false,
                    strictInfrastructureErrors: true,
                };
                const evidence =
                    await this.deps.retrieval.execute(evidenceInput);
                if (evidence.status === "not_found") {
                    return { status: "missing" } as const;
                }
                if (
                    evidence.status !== "ready" ||
                    !evidence.telemetry.retrieval
                ) {
                    throw new Error(
                        `Shadow retrieval returned ${evidence.status}`
                    );
                }
                const diagnostics = evidence.telemetry.retrieval;
                if (diagnostics.mode !== "reranked") {
                    throw new Error(
                        "Shadow retrieval did not use rerank-rag-v1"
                    );
                }

                const baselineSources = sourceRanks(
                    records.assistant!.contextSources
                );
                const candidateSources = sourceRanks(evidence.sources);
                const shadow: RagShadowResult = {
                    version: "rag-shadow-v1",
                    completedAt: this.deps.clock.now().toISOString(),
                    baseline: {
                        pipelineVersion:
                            baselineMetadata.pipelineVersion as string,
                        sources: baselineSources,
                        traceId: baselineTraceId,
                    },
                    candidate: {
                        pipelineVersion: "rerank-rag-v1",
                        sources: candidateSources,
                        retrievalDurationMs: diagnostics.durationMs,
                        reranker: {
                            requestedModel: diagnostics.reranker.requestedModel,
                            resolvedModel: diagnostics.reranker.resolvedModel,
                            status: diagnostics.reranker.status,
                            durationMs: diagnostics.reranker.durationMs,
                            fallbackReason: diagnostics.reranker.fallbackReason,
                            usage: diagnostics.reranker.usage,
                            estimatedCost: diagnostics.reranker.estimatedCost,
                        },
                        maxWordTrigramJaccard:
                            diagnostics.diversity.maxWordTrigramJaccard,
                        traceId: activeTrace.traceId ?? null,
                    },
                    comparison: compareShadowSourceRanks(
                        baselineSources,
                        candidateSources
                    ),
                };
                const persisted = await this.deps.repository.persist(
                    input.payload.assistantMessageId,
                    shadow
                );
                return {
                    status: persisted ? "completed" : "already_completed",
                    shadow,
                } as const;
            }
        );
    }
}
