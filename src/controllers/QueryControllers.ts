// src/controllers/QueryController.ts
import { Request, Response } from "express";
import { ProcessQueryRequest, QueryResponse } from "../types";
import { EPUBProcessor } from "../services/EPUBProcessor";

// Define QueryController class
export class QueryController {
    private epubProcessor: EPUBProcessor;

    // Initialize EPUBProcessor with bucket name
    constructor(bucketName: string) {
        this.epubProcessor = new EPUBProcessor();
    }

    // Define query handler function for Express route handler
    async handleProcess(fileBuffer: Buffer) {
        if (!fileBuffer || fileBuffer.length === 0) {
            return { error: "Invalid or empty file buffer" };
        }
        try {
            const result = await this.epubProcessor.processBook(fileBuffer);

            if (result.error) {
                console.error(`Book processing error: ${result.error}`);
                return { error: result.error };
            }

            if (!result.collectionName) {
                return { error: "No collection name returned from processing" };
            }

            return {
                collectionName: result.collectionName,
                message: "Book processed successfully",
            };
        } catch (error) {
            console.error("Book processing error:", error);
            return {
                error:
                    error instanceof Error
                        ? error.message
                        : "Error processing book",
            };
        }
    }
    //query
    async handleQuery(req: Request, res: Response) {
        try {
            const { collectionName, query } = req.body;
            const result = await this.epubProcessor.queryCollection(
                collectionName,
                query
            );
            res.json(result);
        } catch (error) {
            res.status(500).json({ error: "Error querying collection" });
        }
    }
    async deleteCollection(collectionName: string) {
        return this.epubProcessor.deleteCollection(collectionName);
    }
    async handleDelete(req: Request, res: Response) {
        try {
            const { collectionName } = req.params;
            const success =
                await this.epubProcessor.deleteCollection(collectionName);

            if (success) {
                res.status(200).json({
                    message: `Collection ${collectionName} deleted successfully`,
                });
            } else {
                res.status(500).json({ error: "Failed to delete collection" });
            }
        } catch (error) {
            res.status(500).json({ error: "Error deleting collection" });
        }
    }
}

export const queryController = new QueryController(
    process.env.DO_SPACES_NAME || ""
);
