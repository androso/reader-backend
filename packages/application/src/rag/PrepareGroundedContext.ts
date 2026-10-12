import type { ChatHighlight, ChatPromptMessage } from "@reader/domain";
import type { RetrieveBookEvidenceResult } from "./RetrieveBookEvidence";
import { buildGroundedSystemPrompt } from "./policies/groundedPrompt";

export type PrepareGroundedContextInput = {
    evidence: RetrieveBookEvidenceResult;
    messages: ChatPromptMessage[];
    highlightContext: ChatHighlight | null;
};

export type PreparedGroundedContext = {
    context: string | null;
    systemPrompt: string | null;
    messages: ChatPromptMessage[];
    promptVersion: string;
};

export class PrepareGroundedContext {
    execute(input: PrepareGroundedContextInput): PreparedGroundedContext {
        const promptVersion = input.evidence.telemetry.promptVersion;
        if (
            input.evidence.status !== "ready" ||
            !input.evidence.results?.length
        ) {
            return {
                context: null,
                systemPrompt: null,
                messages: input.messages,
                promptVersion,
            };
        }

        const context = input.evidence.results
            .map((result) => result.content)
            .join("\n\n---\n\n");
        const systemPrompt = buildGroundedSystemPrompt(
            context,
            input.highlightContext
        );
        return {
            context,
            systemPrompt,
            messages: [
                { role: "system", content: systemPrompt },
                ...input.messages,
            ],
            promptVersion,
        };
    }
}
