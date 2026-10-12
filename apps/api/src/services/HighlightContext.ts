import type { ChatMessage } from "./OpenAIServices";
import type { ChatHighlight as HighlightContext } from "@reader/domain";
import { getRagPipeline } from "./RagPipeline";
import {
    addHighlightContextMessage as addHighlightContextPolicy,
    buildGroundedSystemPrompt,
    buildRetrievalQuery as buildRetrievalQueryPolicy,
} from "@reader/application";

export {
    HIGHLIGHT_CONTEXT_MAX_CHARS,
    normalizeEpubHighlight as normalizeHighlightContext,
    type ChatHighlight as HighlightContext,
} from "@reader/domain";

export const buildRetrievalQuery = (
    query: string,
    highlightContext: HighlightContext | null
) => buildRetrievalQueryPolicy(query, highlightContext);

export const buildBookContextSystemPrompt = (
    bookContext: string,
    highlightContext: HighlightContext | null
) => {
    getRagPipeline();
    return buildGroundedSystemPrompt(bookContext, highlightContext);
};

export const addHighlightContextMessage = (
    messages: ChatMessage[],
    highlightContext: HighlightContext | null
) => {
    return addHighlightContextPolicy(messages, highlightContext);
};
