import { useState, useCallback } from "react";
import { processEpubFile } from "../lib/epubProcessing";
import { type EpubContent } from "../types/EpubReader";
import JSZip from "jszip";

export const useEpubProcessor = () => {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [epubContent, setEpubContent] = useState<EpubContent | null>(null);
    const [zipData, setZipData] = useState<JSZip | null>(null);

    const processEpub = useCallback(async (url: string) => {
        try {
            setIsLoading(true);
            setError(null);
            const token = localStorage.getItem("token");
            const response = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch EPUB: ${response.statusText}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const [content, zip] = await processEpubFile(arrayBuffer);

            setZipData(zip);
            setEpubContent(content);
        } catch (err) {
            const errorMessage =
                err instanceof Error ? err.message : "Unknown error occurred";
            setError("Failed to process EPUB file: " + errorMessage);
            console.error(err);
        } finally {
            setIsLoading(false);
        }
    }, []);

    return {
        processEpub,
        isLoading,
        error,
        epubContent,
        zipData,
    };
};
