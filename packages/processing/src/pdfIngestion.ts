import crypto from "crypto";
import PDFParser from "pdf2json";
import { TextChunker } from "./chunkText";
import type { ProcessedTextChunk } from "./bookProcessing";

export const extractPdfChunks = async (
    fileBuffer: Buffer,
    chunker = new TextChunker()
): Promise<ProcessedTextChunk[]> =>
    new Promise((resolve, reject) => {
        const parser = new PDFParser();
        const allChunks: ProcessedTextChunk[] = [];
        const cleanup = () => parser.removeAllListeners();

        parser.on("pdfParser_dataReady", (pdfData) => {
            try {
                for (const [pageIndex, page] of pdfData.Pages.entries()) {
                    const textPage = page.Texts.map((text) =>
                        decodeURIComponent(text.R[0].T)
                    ).join(" ");
                    allChunks.push(
                        ...chunker.chunkText(textPage).map((content) => ({
                            content,
                            metadata: {
                                pageNumber: pageIndex + 1,
                            },
                        }))
                    );
                }
                cleanup();
                resolve(allChunks);
            } catch (error) {
                cleanup();
                reject(error);
            }
        });

        parser.on("pdfParser_dataError", (error) => {
            cleanup();
            reject(error);
        });

        parser.parseBuffer(fileBuffer);
    });

export const createPdfCollectionName = async (
    fileBuffer: Buffer
): Promise<string> =>
    new Promise((resolve, reject) => {
        const parser = new PDFParser();
        const cleanup = () => parser.removeAllListeners();

        parser.on("pdfParser_dataReady", (pdfData) => {
            try {
                const hash = crypto.createHash("sha256");
                hash.update(
                    JSON.stringify({
                        pages: pdfData.Pages.length,
                        info: pdfData.Meta,
                    })
                );
                cleanup();
                resolve(`pdf_${hash.digest("hex").slice(0, 12)}`);
            } catch (error) {
                cleanup();
                reject(error);
            }
        });

        parser.on("pdfParser_dataError", (error) => {
            cleanup();
            reject(error);
        });

        parser.parseBuffer(fileBuffer);
    });
