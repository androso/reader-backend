import type { RagShadowJob } from "./ports";

export type RagShadowEnqueueInput = RagShadowJob & {
    hasHighlightContext: boolean;
};

export interface EnqueueRagShadowComparisonDependencies {
    getSampleRate(): number;
    shouldSample(assistantMessageId: string, sampleRate: number): boolean;
    enqueue(payload: RagShadowJob): Promise<void>;
}

export class EnqueueRagShadowComparison {
    constructor(
        private readonly deps: EnqueueRagShadowComparisonDependencies
    ) {}

    async execute(input: RagShadowEnqueueInput) {
        if (input.hasHighlightContext) {
            return { status: "excluded_highlight" } as const;
        }

        let sampleRate: number;
        try {
            sampleRate = this.deps.getSampleRate();
        } catch (error) {
            return {
                status: "invalid_configuration",
                error,
            } as const;
        }
        if (!this.deps.shouldSample(input.assistantMessageId, sampleRate)) {
            return { status: "not_sampled" } as const;
        }

        const { hasHighlightContext: _hasHighlightContext, ...payload } = input;
        try {
            await this.deps.enqueue(payload);
            return { status: "enqueued" } as const;
        } catch (error) {
            return {
                status: "enqueue_failed",
                error,
            } as const;
        }
    }
}
