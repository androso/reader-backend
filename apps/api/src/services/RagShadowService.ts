import type { RagRerankShadowJobData } from "@reader/jobs";
import { createLogger } from "@reader/providers";
import {
    ProcessRagShadowComparison,
    compareShadowSourceRanks,
    RagShadowAuthorizationError,
    validateRagShadowRecords,
    type RagShadowJob,
    type RagShadowRecords as ApplicationRagShadowRecords,
    type RagShadowTracing,
} from "@reader/application";
import type { RagShadowResult } from "@reader/domain";
import { retrieveBookEvidence } from "./BookRagService";
import { createDrizzleRagShadowRepository } from "../infrastructure/rag/shadowRepository";
import { ragShadowTracing } from "../infrastructure/rag/shadowTracing";
import { db } from "../db";
import {
    getContentFreeTraceObservation,
    getNoopTraceObservation,
    withRagShadowTrace,
    type TraceObservation,
} from "../observability/langfuse";

const log = createLogger("ragShadow");
const repository = createDrizzleRagShadowRepository(db);

export type RagShadowRecords = ApplicationRagShadowRecords;

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

const defaultDependencies: RagShadowDependencies = {
    load: (payload) => repository.load(payload),
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
    persist: (assistantMessageId, shadow) =>
        repository.persist(assistantMessageId, shadow),
};

const createCompatibilityTracing = (): RagShadowTracing => ({
    withShadowTrace(context, callback) {
        return withRagShadowTrace(context, (trace) => callback(trace as never));
    },
    contentFree(trace) {
        return getContentFreeTraceObservation(trace as never) as never;
    },
});

export const processRagRerankShadow = async (
    payload: RagRerankShadowJobData,
    dependencies: RagShadowDependencies = defaultDependencies,
    trace: TraceObservation = getNoopTraceObservation()
) => {
    const process = new ProcessRagShadowComparison({
        repository: {
            load: dependencies.load,
            persist: dependencies.persist,
        },
        retrieval: {
            execute: (options) =>
                dependencies.retrieve({
                    bookId: options.bookId,
                    userId: options.userId,
                    query: options.query,
                    trace: options.trace as never,
                }) as never,
        },
        tracing:
            dependencies === defaultDependencies
                ? ragShadowTracing
                : createCompatibilityTracing(),
        clock: { now: () => new Date() },
    });
    return process.execute({
        payload: payload as RagShadowJob,
        trace: trace as never,
    });
};

export {
    compareShadowSourceRanks,
    RagShadowAuthorizationError,
    validateRagShadowRecords,
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
