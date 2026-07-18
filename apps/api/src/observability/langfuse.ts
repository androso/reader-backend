import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
    propagateAttributes,
    startActiveObservation,
    type LangfuseObservation,
    type LangfuseObservationAttributes,
    type LangfuseObservationType,
    type LangfuseTraceAttributes,
    type PropagateAttributesParams,
} from "@langfuse/tracing";
import type { LangfuseConfig } from "@langfuse/openai";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { createLogger } from "@reader/providers";

const log = createLogger("langfuse");
const DEFAULT_MAX_CAPTURE_CHARS = 500;
const MIN_MAX_CAPTURE_CHARS = 20;
const SENSITIVE_TEXT_KEYS = new Set([
    "content",
    "prompt",
    "query",
    "context",
    "completion",
    "response",
    "assistantResponse",
    "documents",
    "document",
    "text",
    "error",
]);

let sdk: NodeSDK | null = null;

export type LangfuseCaptureMode = "metadata" | "snippets";

export interface LangfuseCaptureConfig {
    mode: LangfuseCaptureMode;
    maxChars: number;
}

export interface TraceObservation {
    readonly id?: string;
    readonly traceId?: string;
    update(attributes: LangfuseObservationAttributes): TraceObservation;
    setTraceIO(attributes: LangfuseTraceAttributes): TraceObservation;
    startObservation(
        name: string,
        attributes?: LangfuseObservationAttributes,
        options?: { asType?: LangfuseObservationType }
    ): TraceObservation;
    end(): void;
    getSpanContext(): LangfuseConfig["parentSpanContext"] | undefined;
}

const noopObservation: TraceObservation = (() => {
    let noop: TraceObservation;
    noop = {
        update: () => noop,
        setTraceIO: () => noop,
        startObservation: () => noop,
        end: () => undefined,
        getSpanContext: () => undefined,
    };
    return noop;
})();

const parsePositiveInteger = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < MIN_MAX_CAPTURE_CHARS) {
        return fallback;
    }
    return parsed;
};

const parseSampleRate = () => {
    const raw = process.env.LANGFUSE_SAMPLE_RATE;
    if (!raw) return 1;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 1;
    if (parsed <= 0) return 0;
    if (parsed >= 1) return 1;
    return parsed;
};

export const isLangfuseTracingConfigured = () =>
    Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

export const isLangfuseTracingEnabled = () =>
    isLangfuseTracingConfigured() && parseSampleRate() > 0;

export const getLangfuseCaptureConfig = (): LangfuseCaptureConfig => ({
    mode:
        process.env.LANGFUSE_CAPTURE_CONTENT === "snippets"
            ? "snippets"
            : "metadata",
    maxChars: parsePositiveInteger(
        process.env.LANGFUSE_MAX_CAPTURE_CHARS,
        DEFAULT_MAX_CAPTURE_CHARS
    ),
});

export const snippetForLangfuse = (
    text: string,
    capture = getLangfuseCaptureConfig()
) => {
    if (capture.mode !== "snippets") return undefined;
    return text.replace(/\s+/g, " ").trim().slice(0, capture.maxChars);
};

const shouldMaskString = (key: string | undefined) =>
    key ? SENSITIVE_TEXT_KEYS.has(key) : false;

const maskValue = (
    value: unknown,
    key: string | undefined,
    capture: LangfuseCaptureConfig
): unknown => {
    if (typeof value === "string") {
        if (capture.mode === "snippets") {
            return value.replace(/\s+/g, " ").trim().slice(0, capture.maxChars);
        }

        return shouldMaskString(key) ? "[redacted]" : value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => maskValue(item, key, capture));
    }

    if (value && typeof value === "object") {
        const masked: Record<string, unknown> = {};
        for (const [childKey, childValue] of Object.entries(
            value as Record<string, unknown>
        )) {
            masked[childKey] = maskValue(childValue, childKey, capture);
        }
        return masked;
    }

    return value;
};

const stringifyLangfuseAttribute = (value: unknown) => {
    try {
        return typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        return "<failed to serialize>";
    }
};

export const maskLangfuseAttribute = (
    data: unknown,
    capture = getLangfuseCaptureConfig()
) => {
    if (typeof data !== "string") {
        return maskValue(data, undefined, capture);
    }

    try {
        const parsed = JSON.parse(data);
        return stringifyLangfuseAttribute(
            maskValue(parsed, undefined, capture)
        );
    } catch {
        return maskValue(data, undefined, capture);
    }
};

const wrapObservation = (
    observation: LangfuseObservation
): TraceObservation => {
    const wrapped: TraceObservation = {
        id: observation.id,
        traceId: observation.traceId,
        update(attributes) {
            (observation as any).update(attributes);
            return wrapped;
        },
        setTraceIO(attributes) {
            observation.setTraceIO(attributes);
            return wrapped;
        },
        startObservation(name, attributes, options) {
            return wrapObservation(
                (observation as any).startObservation(name, attributes, options)
            );
        },
        end() {
            observation.end();
        },
        getSpanContext() {
            return observation.otelSpan.spanContext();
        },
    };

    return wrapped;
};

export const getNoopTraceObservation = () => noopObservation;

const CONTENT_FREE_CAPTURE: LangfuseCaptureConfig = {
    mode: "metadata",
    maxChars: DEFAULT_MAX_CAPTURE_CHARS,
};

export const getContentFreeTraceObservation = (
    observation: TraceObservation
): TraceObservation => {
    let wrapped: TraceObservation;
    wrapped = {
        id: observation.id,
        traceId: observation.traceId,
        update(attributes) {
            observation.update(
                maskLangfuseAttribute(
                    attributes,
                    CONTENT_FREE_CAPTURE
                ) as LangfuseObservationAttributes
            );
            return wrapped;
        },
        setTraceIO(attributes) {
            observation.setTraceIO(
                maskLangfuseAttribute(
                    attributes,
                    CONTENT_FREE_CAPTURE
                ) as LangfuseTraceAttributes
            );
            return wrapped;
        },
        startObservation(name, attributes, options) {
            const sanitized = attributes
                ? (maskLangfuseAttribute(
                      attributes,
                      CONTENT_FREE_CAPTURE
                  ) as LangfuseObservationAttributes)
                : undefined;
            return getContentFreeTraceObservation(
                observation.startObservation(name, sanitized, options)
            );
        },
        end: () => observation.end(),
        getSpanContext: () => observation.getSpanContext(),
    };
    return wrapped;
};

export const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

export const recordObservationError = (
    observation: TraceObservation | undefined,
    error: unknown,
    statusMessage = "Observation failed"
) => {
    if (!observation) return;
    observation.update({
        level: "ERROR",
        statusMessage,
        output: { error: getErrorMessage(error) },
    });
};

export const shutdownLangfuseTracing = async () => {
    if (!sdk) return;

    const activeSdk = sdk;
    sdk = null;

    try {
        await activeSdk.shutdown();
    } catch (error) {
        log.warn("Error shutting down Langfuse tracing", {
            error: getErrorMessage(error),
        });
    }
};

export const startLangfuseTracing = (serviceName = "reader-api") => {
    if (!isLangfuseTracingConfigured()) {
        log.info("Langfuse tracing disabled; missing credentials");
        return;
    }

    if (sdk) return;

    const sampleRate = parseSampleRate();
    if (sampleRate <= 0) {
        log.info("Langfuse tracing disabled by sample rate");
        return;
    }

    const capture = getLangfuseCaptureConfig();
    sdk = new NodeSDK({
        serviceName,
        sampler: new TraceIdRatioBasedSampler(sampleRate),
        spanProcessors: [
            new LangfuseSpanProcessor({
                publicKey: process.env.LANGFUSE_PUBLIC_KEY,
                secretKey: process.env.LANGFUSE_SECRET_KEY,
                baseUrl: process.env.LANGFUSE_BASE_URL || undefined,
                environment: process.env.NODE_ENV || "development",
                mask: ({ data }) => {
                    return maskLangfuseAttribute(data, capture);
                },
            }),
        ],
    });

    sdk.start();
    log.info("Langfuse tracing enabled", {
        sampleRate,
        captureMode: capture.mode,
        maxCaptureChars: capture.maxChars,
        hasBaseUrl: Boolean(process.env.LANGFUSE_BASE_URL),
    });
};

export interface BookChatTraceContext {
    userId: string;
    conversationId: string;
    resourceType: string;
    resourceId: string;
    routeName: string;
    messageCount: number;
    queryLength: number;
    hasHighlightContext?: boolean;
}

export interface RagShadowTraceContext {
    userId: string;
    conversationId: string;
    bookId: string;
    assistantMessageId: string;
    baselineTraceId: string | null;
}

export const withRagShadowTrace = <T>(
    context: RagShadowTraceContext,
    fn: (trace: TraceObservation) => T
): T => {
    if (!isLangfuseTracingEnabled()) return fn(noopObservation);

    return startActiveObservation(
        "rag_rerank_shadow",
        (observation) => {
            const trace = wrapObservation(observation);
            return propagateAttributes(
                {
                    traceName: "rag_rerank_shadow",
                    userId: context.userId,
                    sessionId: context.conversationId,
                    tags: ["reader-worker", "rag-shadow", "rerank-rag-v1"],
                    metadata: {
                        bookId: context.bookId,
                        assistantMessageId: context.assistantMessageId,
                        ...(context.baselineTraceId
                            ? { baselineTraceId: context.baselineTraceId }
                            : {}),
                        environment: process.env.NODE_ENV || "development",
                    },
                },
                () => fn(trace)
            );
        },
        { endOnExit: true }
    );
};

export const withBookChatTrace = <T>(
    context: BookChatTraceContext,
    fn: (trace: TraceObservation) => T
): T => {
    if (!isLangfuseTracingEnabled()) {
        return fn(noopObservation);
    }

    return startActiveObservation(
        "chat_with_book",
        (observation) => {
            const trace = wrapObservation(observation);
            const propagated: PropagateAttributesParams = {
                traceName: "chat_with_book",
                userId: context.userId,
                sessionId: context.conversationId,
                tags: ["reader-api", "book-chat", context.routeName],
                metadata: {
                    routeName: context.routeName,
                    resourceType: context.resourceType,
                    resourceId: context.resourceId,
                    environment: process.env.NODE_ENV || "development",
                },
            };

            return propagateAttributes(propagated, () => {
                trace.setTraceIO({
                    input: {
                        resourceType: context.resourceType,
                        resourceId: context.resourceId,
                        messageCount: context.messageCount,
                        queryLength: context.queryLength,
                        hasHighlightContext: Boolean(
                            context.hasHighlightContext
                        ),
                    },
                });

                try {
                    const result = fn(trace);
                    if (result instanceof Promise) {
                        return result.catch((error) => {
                            recordObservationError(
                                trace,
                                error,
                                "Book chat failed"
                            );
                            throw error;
                        }) as T;
                    }

                    return result;
                } catch (error) {
                    recordObservationError(trace, error, "Book chat failed");
                    throw error;
                }
            });
        },
        { endOnExit: true }
    );
};
