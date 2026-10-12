import type { Database } from "../../database/database.module";
import { db } from "../../db";
import { estimateModelCost, normalizeModelUsage } from "../../services/AiUsage";
import { createLogger } from "@reader/providers";
import type { RetrieveBookEvidenceDependencies } from "@reader/application";
import { createBookChunkReader } from "./chunkReader";
import { createOwnedBookLookup } from "./ownedBookLookup";
import { lexicalSearch } from "./lexicalSearch";
import { ragConfiguration } from "./ragConfig";
import { ragReranker } from "./reranker";
import { vectorSearch } from "./vectorSearch";
import { RetrieveBookEvidence } from "@reader/application";

export const createRetrieveBookEvidence = (
    database: Database = db,
    overrides: Partial<RetrieveBookEvidenceDependencies> = {}
) =>
    new RetrieveBookEvidence({
        books: createOwnedBookLookup(database),
        chunks: createBookChunkReader(database),
        lexical: lexicalSearch,
        vector: vectorSearch,
        reranker: ragReranker,
        config: ragConfiguration,
        clock: { now: () => new Date() },
        accounting: {
            normalizeUsage: normalizeModelUsage,
            estimateCost: estimateModelCost,
        },
        loggers: {
            bookRag: createLogger("bookRag"),
            rerankedRetrieval: createLogger("rerankedRetrieval"),
        },
        ...overrides,
    });

export const retrieveBookEvidenceUseCase = createRetrieveBookEvidence();
