import { and, eq, isNull, sql } from "drizzle-orm";
import type { RagRerankShadowJobData } from "@reader/jobs";
import { createLogger } from "@reader/providers";
import { db } from "../db";
import {
    Books,
    Conversations,
    Messages,
    type MessageContextSource,
} from "../db/schema";
import {
    getNoopTraceObservation,
    withRagShadowTrace,
    type TraceObservation,
} from "../observability/langfuse";
import type {
    MessageExecutionMetadata,
    RagShadowResult,
    RagShadowSourceRank,
    RerankedRetrievalDiagnostics,
} from "../types/ragTelemetry";
import { retrieveBookEvidence } from "./BookRagService";

const log = createLogger("ragShadow");

export class RagShadowAuthorizationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RagShadowAuthorizationError";
    }
}

export interface RagShadowRecords {
    assistant: {
        id: string;
        role: "user" | "assistant";
        conversationId: string;
        contextSources: MessageContextSource[] | null;
        executionMetadata: MessageExecutionMetadata | null;
    } | null;
    userMessage: {
        id: string;
        role: "user" | "assistant";
        conversationId: string;
        content: string;
    } | null;
    conversation: {
        id: string;
        userId: string;
        resourceType: "book" | "article";
        resourceId: string;
    } | null;
    book: { id: string; userId: string } | null;
}

export interface RagShadowDependencies {
    load(payload: RagRerankShadowJobData): Promise<RagShadowRecords>;
    retrieve(options: {
        bookId: string;
        userId: string;
        query: string;
        trace: TraceObservation;
    }): ReturnType<typeof retrieveBookEvidence>;
    persist(
        assistantMessageId: string,
        shadow: RagShadowResult
    ): Promise<boolean>;
}

const loadRecords = async (
    payload: RagRerankShadowJobData
): Promise<RagShadowRecords> => {
    const [assistantRows, userRows, conversationRows, bookRows] =
        await Promise.all([
            db
                .select({
                    id: Messages.id,
                    role: Messages.role,
                    conversationId: Messages.conversationId,
                    contextSources: Messages.contextSources,
                    executionMetadata: Messages.executionMetadata,
                })
                .from(Messages)
                .where(eq(Messages.id, payload.assistantMessageId)),
            db
                .select({
                    id: Messages.id,
                    role: Messages.role,
                    conversationId: Messages.conversationId,
                    content: Messages.content,
                })
                .from(Messages)
                .where(eq(Messages.id, payload.userMessageId)),
            db
                .select({
                    id: Conversations.id,
                    userId: Conversations.userId,
                    resourceType: Conversations.resourceType,
                    resourceId: Conversations.resourceId,
                })
                .from(Conversations)
                .where(eq(Conversations.id, payload.conversationId)),
            db
                .select({ id: Books.id, userId: Books.userId })
                .from(Books)
                .where(eq(Books.id, payload.bookId)),
        ]);

    return {
        assistant: assistantRows[0] ?? null,
        userMessage: userRows[0] ?? null,
        conversation: conversationRows[0] ?? null,
        book: bookRows[0] ?? null,
    };
};

const persistShadow = async (
    assistantMessageId: string,
    shadow: RagShadowResult
) => {
    const [updated] = await db
        .update(Messages)
        .set({
            executionMetadata: sql<MessageExecutionMetadata>`jsonb_set(${Messages.executionMetadata}, '{shadow}', ${JSON.stringify(shadow)}::jsonb, true)`,
        })
        .where(
            and(
                eq(Messages.id, assistantMessageId),
                isNull(sql`${Messages.executionMetadata}->'shadow'`)
            )
        )
        .returning({ id: Messages.id });
    return Boolean(updated);
};

const defaultDependencies: RagShadowDependencies = {
    load: loadRecords,
    retrieve: ({ bookId, userId, query, trace }) =>
        retrieveBookEvidence({
            bookId,
            userId,
            query,
            trace,
            strict: true,
            pipelineVersion: "rerank-rag-v1",
            includeErrorDetailInLogs: false,
            strictRerankInfrastructureErrors: true,
        }),
    persist: persistShadow,
};

const sourceRanks = (
    sources: Array<Pick<MessageContextSource, "id">> | null | undefined
): RagShadowSourceRank[] =>
    (sources ?? []).map((source, index) => ({
        id: source.id,
        rank: index + 1,
    }));

export const compareShadowSourceRanks = (
    baseline: RagShadowSourceRank[],
    candidate: RagShadowSourceRank[]
) => {
    const baselineIds = new Set(baseline.map((source) => source.id));
    const candidateIds = new Set(candidate.map((source) => source.id));
    let overlapCount = 0;
    for (const id of baselineIds) {
        if (candidateIds.has(id)) overlapCount += 1;
    }
    const unionSize = new Set([...baselineIds, ...candidateIds]).size;
    const exactRankMatches = baseline.filter(
        (source, index) => candidate[index]?.id === source.id
    ).length;
    return {
        overlapCount,
        sourceSetJaccard: unionSize === 0 ? 1 : overlapCount / unionSize,
        exactRankMatches,
        identical:
            baseline.length === candidate.length &&
            exactRankMatches === baseline.length,
    };
};

export const validateRagShadowRecords = (
    payload: RagRerankShadowJobData,
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
    if (records.assistant.executionMetadata?.shadow) {
        return "already_completed" as const;
    }
    if (
        records.assistant.role !== "assistant" ||
        records.userMessage.role !== "user" ||
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
    if (!records.assistant.executionMetadata) {
        throw new Error(
            "Assistant message is missing baseline execution metadata"
        );
    }
    return "authorized" as const;
};

const runAuthorizedShadow = async (
    payload: RagRerankShadowJobData,
    records: RagShadowRecords,
    dependencies: RagShadowDependencies,
    trace: TraceObservation
) => {
    const assistant = records.assistant!;
    const userMessage = records.userMessage!;
    const baselineMetadata = assistant.executionMetadata!;
    const evidence = await dependencies.retrieve({
        bookId: payload.bookId,
        userId: payload.userId,
        query: userMessage.content,
        trace,
    });
    if (evidence.status === "not_found") {
        return { status: "missing" } as const;
    }
    if (evidence.status !== "ready" || !evidence.telemetry.retrieval) {
        throw new Error(`Shadow retrieval returned ${evidence.status}`);
    }
    const diagnostics = evidence.telemetry
        .retrieval as RerankedRetrievalDiagnostics;
    if (diagnostics.mode !== "reranked") {
        throw new Error("Shadow retrieval did not use rerank-rag-v1");
    }

    const baselineSources = sourceRanks(assistant.contextSources);
    const candidateSources = sourceRanks(evidence.sources);
    const shadow: RagShadowResult = {
        version: "rag-shadow-v1",
        completedAt: new Date().toISOString(),
        baseline: {
            pipelineVersion: baselineMetadata.pipelineVersion,
            sources: baselineSources,
            traceId: baselineMetadata.langfuseTraceId,
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
            maxWordTrigramJaccard: diagnostics.diversity.maxWordTrigramJaccard,
            traceId: trace.traceId ?? null,
        },
        comparison: compareShadowSourceRanks(baselineSources, candidateSources),
    };
    const persisted = await dependencies.persist(
        payload.assistantMessageId,
        shadow
    );
    return {
        status: persisted ? "completed" : "already_completed",
        shadow,
    } as const;
};

export const processRagRerankShadow = async (
    payload: RagRerankShadowJobData,
    dependencies: RagShadowDependencies = defaultDependencies,
    trace: TraceObservation = getNoopTraceObservation()
) => {
    const records = await dependencies.load(payload);
    const validation = validateRagShadowRecords(payload, records);
    if (validation !== "authorized") return { status: validation } as const;

    const baselineTraceId =
        records.assistant!.executionMetadata!.langfuseTraceId;
    return withRagShadowTrace(
        {
            userId: payload.userId,
            conversationId: payload.conversationId,
            bookId: payload.bookId,
            assistantMessageId: payload.assistantMessageId,
            baselineTraceId,
        },
        (shadowTrace) =>
            runAuthorizedShadow(
                payload,
                records,
                dependencies,
                trace.traceId ? trace : shadowTrace
            )
    );
};

export const logRagShadowResult = (
    payload: RagRerankShadowJobData,
    status: string,
    durationMs: number
) => {
    log.info("RAG shadow job finished", {
        assistantMessageId: payload.assistantMessageId,
        conversationId: payload.conversationId,
        bookId: payload.bookId,
        status,
        durationMs,
    });
};
