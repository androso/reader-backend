import { useState, useCallback, useEffect } from "react";
import { processEpubFile } from "@/lib/epubProcessing";
import { type EpubContent } from "@/types/EpubReader";
import JSZip from "jszip";
import ePub from "epubjs";
import Section from "epubjs/types/section";

export const useEpubProcessor = () => {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [epubContent, setEpubContent] = useState<EpubContent | null>(null);
    const [zipData, setZipData] = useState<JSZip | null>(null);

    const processEpub = useCallback(async (url: string) => {
        try {
            setIsLoading(true);
            setError(null);
            const response = await fetch(url, {
                credentials: "include",
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

export const useEpubJsProcessor = (url: string) => {
    const [bookChapters, setBookChapters] = useState<
        { id: string; content: string }[]
    >([]);
    const [chaptersLoading, setChaptersLoading] = useState(false);
    const [status, setStatus] = useState<
        "loading" | "error" | "idle" | "success"
    >("idle");

    const processEpubJs = async (bookUrl: string) => {
        setStatus("loading");
        setChaptersLoading(true);
        let book = ePub(bookUrl, {
            requestCredentials: true,
        });

        await book.loaded.navigation;
        book = await book.opened;
        const spineItems: Section[] = [];
        book.spine.each((spineItem: Section) => spineItems.push(spineItem));
        const chapters = [];
        for (const item of spineItems) {
            const document = (await book.load(item.href)) as Document;
            const images = document.body.getElementsByTagName("img");
            const basePath = "";

            // Process all images in parallel
            await Promise.all(
                Array.from(images).map(async (img) => {
                    const src = img.getAttribute("src");
                    if (src) {
                        try {
                            const relativePath = src.startsWith("/")
                                ? src.slice(1)
                                : src;
                            const fullPath = basePath
                                ? `${basePath}/${relativePath}`
                                : relativePath;
                            const imageBlob =
                                await book.archive.getBlob(fullPath);

                            if (imageBlob) {
                                const arrayBuffer =
                                    await imageBlob.arrayBuffer();
                                const dataUrl =
                                    await createImageDataUrl(arrayBuffer);
                                img.src = dataUrl;
                            } else {
                                console.warn(
                                    `Image not found in epub: ${fullPath}`
                                );
                                img.src =
                                    'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Cpath fill="%23eee" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/%3E%3C/svg%3E';
                            }
                        } catch (error) {
                            console.error(
                                `Failed to load image: ${src}`,
                                error
                            );
                            img.src =
                                'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Cpath fill="%23eee" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/%3E%3C/svg%3E';
                        }
                    }
                })
            );

            chapters.push({
                id: item.href,
                content: document.body.innerHTML,
            });
        }
        setBookChapters(chapters);
        setStatus("success");
    };

    useEffect(() => {
        if (!url) return;
        processEpubJs(url);
    }, [url]);

    return {
        epubJsContent: {},
        processEpubJs,
        bookChapters,
        chaptersLoading,
        status,
    };
};

async function createImageDataUrl(arrayBuffer: ArrayBuffer): Promise<string> {
    const blob = new Blob([new Uint8Array(arrayBuffer)]);
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
