import OpenAI from "openai";
import dotenv from "dotenv";
import { observeOpenAI, type LangfuseConfig } from "@langfuse/openai";
import { isLangfuseTracingEnabled } from "../observability/langfuse";
import type {
    ChatCompletionCreateParamsStreaming,
    ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

dotenv.config();

export type ChatMessage = {
    role: "user" | "assistant" | "system";
    content: string;
};

export const OPENAI_CHAT_MODELS = [
    "gpt-4o-mini",
    "gpt-5.5-2026-04-23",
    "gpt-5.4-mini-2026-03-17",
] as const;
export type OpenAIChatModel = (typeof OPENAI_CHAT_MODELS)[number];
export const OPENAI_CHAT_MODEL: OpenAIChatModel = OPENAI_CHAT_MODELS[0];
export const OPENAI_CHAT_TEMPERATURE = 0.7;
export const OPENAI_CHAT_MAX_TOKENS = 300;

export const isOpenAIChatModel = (model: unknown): model is OpenAIChatModel =>
    typeof model === "string" &&
    (OPENAI_CHAT_MODELS as readonly string[]).includes(model);

const usesMaxCompletionTokens = (model: OpenAIChatModel) =>
    model !== OPENAI_CHAT_MODEL;

const getModelRequestParameters = (
    model: OpenAIChatModel
): Pick<
    ChatCompletionCreateParamsStreaming,
    "temperature" | "max_tokens" | "max_completion_tokens"
> => {
    if (usesMaxCompletionTokens(model)) {
        return { max_completion_tokens: OPENAI_CHAT_MAX_TOKENS };
    }

    return {
        temperature: OPENAI_CHAT_TEMPERATURE,
        max_tokens: OPENAI_CHAT_MAX_TOKENS,
    };
};

const getInstructionRole = (
    model: OpenAIChatModel
): ChatCompletionMessageParam["role"] =>
    model === OPENAI_CHAT_MODEL ? "system" : "developer";

export interface LangfuseOpenAITraceOptions {
    userId: string;
    sessionId: string;
    generationName: string;
    tags?: string[];
    generationMetadata?: Record<string, unknown>;
    parentSpanContext?: LangfuseConfig["parentSpanContext"];
}

export interface GenerateStreamResponseOptions {
    model?: OpenAIChatModel;
    temperature?: number;
    langfuse?: LangfuseOpenAITraceOptions;
}

export const createOpenAIClientOptions = (): NonNullable<
    ConstructorParameters<typeof OpenAI>[0]
> => {
    const openAiOptions: NonNullable<ConstructorParameters<typeof OpenAI>[0]> =
        {
            apiKey: process.env.OPENAI_API_KEY,
            maxRetries: 0,
            defaultHeaders: {
                "Accept-Encoding": "identity",
            },
        };

    if (typeof globalThis.fetch === "function") {
        openAiOptions.fetch = globalThis.fetch.bind(globalThis) as NonNullable<
            typeof openAiOptions.fetch
        >;
    }

    return openAiOptions;
};

export const buildChatCompletionRequest = (
    userMessages: ChatMessage[],
    systemPrompt = "You are a helpful assistant.",
    model: OpenAIChatModel = OPENAI_CHAT_MODEL,
    temperature?: number
): ChatCompletionCreateParamsStreaming => {
    const modelParameters = getModelRequestParameters(model);
    if (temperature !== undefined && !usesMaxCompletionTokens(model)) {
        modelParameters.temperature = temperature;
    }
    return {
        model: model as ChatCompletionCreateParamsStreaming["model"],
        messages: [
            {
                role: getInstructionRole(model),
                content: systemPrompt,
                name: "system",
            } as ChatCompletionMessageParam,
            ...(userMessages as ChatCompletionMessageParam[]),
        ],
        ...modelParameters,
        stream: true,
        stream_options: {
            include_usage: true,
        },
    };
};

export class OpenAIService {
    private client: OpenAI;

    constructor(client?: OpenAI) {
        this.client = client ?? new OpenAI(createOpenAIClientOptions());
    }

    private getClient(options?: GenerateStreamResponseOptions) {
        if (!options?.langfuse || !isLangfuseTracingEnabled()) {
            return this.client;
        }

        return observeOpenAI(this.client, {
            traceName: "chat_with_book",
            userId: options.langfuse.userId,
            sessionId: options.langfuse.sessionId,
            tags: options.langfuse.tags,
            generationName: options.langfuse.generationName,
            generationMetadata: options.langfuse.generationMetadata,
            parentSpanContext: options.langfuse.parentSpanContext,
        });
    }

    async generateStreamResponse(
        userMessages: ChatMessage[],
        systemPrompt = "You are a helpful assistant.",
        options?: GenerateStreamResponseOptions
    ): Promise<any> {
        const response = await this.getClient(options).chat.completions.create(
            buildChatCompletionRequest(
                userMessages,
                systemPrompt,
                options?.model,
                options?.temperature
            )
        );
        return response;
    }
    async generateResponse(context: string, query: string): Promise<string> {
        const response = await this.client.chat.completions.create({
            model: "gpt-4o-mini-2024-07-18",
            messages: [
                {
                    role: "system",
                    content:
                        "You are a helpful assistant. Answer the question based on the provided context.",
                },
                {
                    role: "user",
                    content: `Context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`,
                },
            ],
            temperature: 0.7,
            max_tokens: 300,
        });

        return response.choices[0].message.content || "";
    }
}
