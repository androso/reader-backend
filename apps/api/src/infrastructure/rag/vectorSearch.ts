import type { VectorSearch } from "@reader/application";
import { vectorStore } from "@reader/providers";
import {
    getLangfuseCaptureConfig,
    recordObservationError,
    snippetForLangfuse,
    type TraceObservation,
} from "../../observability/langfuse";

export const createVectorSearch = (): VectorSearch => ({
    async search(collectionName, query, limit, options) {
        const trace = options?.trace as TraceObservation | undefined;
        const span = trace?.startObservation("vector_search", {
            input: { collectionName, queryLength: query.length, limit },
        });
        const capture = getLangfuseCaptureConfig();
        try {
            const results = await vectorStore.searchDocuments(
                collectionName,
                query,
                limit
            );
            span?.update({
                output: {
                    resultCount: results.length,
                    topResults: results.slice(0, 5).map((result) => ({
                        id: result.id,
                        rank: result.rank,
                        distance: result.distance,
                        ...(capture.mode === "snippets"
                            ? {
                                  snippet: snippetForLangfuse(
                                      result.content,
                                      capture
                                  ),
                              }
                            : {}),
                    })),
                },
            });
            return results;
        } catch (error) {
            recordObservationError(span, error, "Vector search failed");
            throw error;
        } finally {
            span?.end();
        }
    },
});

export const vectorSearch = createVectorSearch();
