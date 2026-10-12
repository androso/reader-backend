import { ChatCancelledError } from "@reader/domain";
import type {
    AnswerModelStream,
    RagAnswerModelChunk,
    RagStreamFailure,
} from "@reader/application";
import {
    OpenAIService,
    type OpenAIChatModel,
} from "../../services/OpenAIServices";

const getErrorDetail = (error: unknown) => {
    if (!error || typeof error !== "object") return String(error);
    const details = error as {
        code?: unknown;
        errno?: unknown;
        message?: unknown;
        name?: unknown;
    };

    return [details.name, details.code, details.errno, details.message]
        .filter(Boolean)
        .join(" ");
};

const classifyStreamFailure = (detail: string): RagStreamFailure["kind"] => {
    if (
        detail.includes("ERR_STREAM_PREMATURE_CLOSE") ||
        detail.includes("Premature close")
    ) {
        return "premature_close";
    }
    const normalized = detail.toLowerCase();
    if (
        normalized.includes("timeout") ||
        normalized.includes("timed out") ||
        normalized.includes("etimedout") ||
        normalized.includes("aborterror")
    ) {
        return "timeout";
    }
    return "provider_error";
};

export const createOpenAIAnswerModelStream = (
    suppliedService?: OpenAIService
): AnswerModelStream => ({
    stream(input) {
        return (async function* () {
            const service = suppliedService ?? new OpenAIService();
            try {
                const stream = await service.generateStreamResponse(
                    input.messages as never,
                    undefined,
                    {
                        model: input.model as OpenAIChatModel,
                        temperature: input.temperature,
                        signal: input.signal,
                        langfuse: input.langfuse as never,
                    }
                );
                for await (const rawChunk of stream) {
                    const chunk = rawChunk as {
                        model?: unknown;
                        choices?: Array<{
                            finish_reason?: unknown;
                            delta?: { content?: unknown };
                        }>;
                        usage?: unknown;
                    };
                    const choice = chunk.choices?.[0];
                    const finishReason =
                        typeof choice?.finish_reason === "string"
                            ? choice.finish_reason
                            : null;
                    const usage =
                        chunk.usage && typeof chunk.usage === "object"
                            ? (chunk.usage as Record<string, unknown>)
                            : null;
                    const output: RagAnswerModelChunk = {
                        delta:
                            typeof choice?.delta?.content === "string"
                                ? choice.delta.content
                                : "",
                        finishReason,
                        usage,
                        resolvedModel:
                            typeof chunk.model === "string" ? chunk.model : "",
                    };
                    yield output;
                }
            } catch (error) {
                if (error instanceof ChatCancelledError) throw error;
                const detail = getErrorDetail(error);
                const message =
                    error instanceof Error ? error.message : String(error);
                const failure = new Error(message) as Error & RagStreamFailure;
                failure.name =
                    error instanceof Error ? error.name : "RagStreamFailure";
                failure.kind = classifyStreamFailure(detail);
                failure.transportWarning = detail;
                throw failure;
            }
        })();
    },
});
