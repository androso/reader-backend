import { useCallback, useReducer, useEffect } from "react";
import JSZip from "jszip";
import { TextBlock, type EpubContent } from "@/types/EpubReader";
import { useImageLoader } from "@/hooks/useImageLoader";
import { resolveRelativePath } from "@/lib/utils";

export interface Chapter {
    id: string;
    content: string;
    hrefId: string;
    textBlocks: TextBlock[];
}

interface ChapterLoaderState {
    chapters: Chapter[];
    isLoading: boolean;
    error: string | null;
    flatTextBlocks: TextBlock[];
}

type ChapterAction =
    | { type: "START_LOADING" }
    | {
          type: "LOAD_SUCCESS";
          payload: { chapters: Chapter[]; flatTextBlocks: TextBlock[] };
      }
    | { type: "LOAD_ERROR"; payload: string };

function chapterReducer(
    state: ChapterLoaderState,
    action: ChapterAction
): ChapterLoaderState {
    switch (action.type) {
        case "START_LOADING":
            return {
                ...state,
                isLoading: true,
                error: null,
            };
        case "LOAD_SUCCESS":
            return {
                ...state,
                chapters: action.payload.chapters,
                isLoading: false,
                flatTextBlocks: action.payload.flatTextBlocks,
                error: null,
            };
        case "LOAD_ERROR":
            return {
                ...state,
                error: action.payload,
                isLoading: false,
            };
    }
}

export const useChapterLoader = (
    epubContent: EpubContent | null,
    zipData: JSZip | null
) => {
    const { loadImage } = useImageLoader(zipData, epubContent?.basePath ?? "");
    const [state, dispatch] = useReducer(chapterReducer, {
        chapters: [],
        isLoading: false,
        error: null,
        flatTextBlocks: [],
    });

    useEffect(() => {
        console.log({ epubContent });
    }, [epubContent]);

    const loadCssContent = useCallback(
        async (href: string, currentPath?: string): Promise<string | null> => {
            if (!epubContent || !zipData) return null;
            try {
                const paths = [
                    href,
                    resolveRelativePath(href, epubContent.basePath),
                    currentPath ? resolveRelativePath(href, currentPath) : null,
                    `${epubContent.basePath}styles/${href}`,
                    `${epubContent.basePath}Styles/${href}`,
                    `${epubContent.basePath}css/${href}`,
                ].filter(Boolean);

                for (const path of paths) {
                    const cssFile = zipData.file(path);
                    if (cssFile) {
                        const content = await cssFile.async("text");
                        return content.replace(
                            /@import\s+['"]([^'"]+)['"]/g,
                            async (_, importPath) => {
                                const importedCss = await loadCssContent(
                                    importPath,
                                    path
                                );
                                return importedCss || "";
                            }
                        );
                    }
                }
            } catch (err) {
                console.warn("Error loading CSS:", href);
            }
            return null;
        },
        [epubContent, zipData]
    );

    const processHtml = useCallback(
        async (
            html: string,
            baseUrl: string,
            chapterId: string
        ): Promise<TextBlock[]> => {
            if (!epubContent) throw new Error("No EPUB content available");
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, "text/html");

            const stylePromises = Array.from(
                doc.querySelectorAll('link[rel="stylesheet"]')
            ).map(async (stylesheet) => {
                const href = stylesheet.getAttribute("href");
                if (href) {
                    const cssContent = await loadCssContent(href);
                    if (cssContent) {
                        const style = doc.createElement("style");
                        style.textContent = cssContent;
                        stylesheet.replaceWith(style);
                    }
                }
            });

            await Promise.all(stylePromises);

            const imagePromises = Array.from(doc.querySelectorAll("img")).map(
                async (img) => {
                    const src = img.getAttribute("src");

                    if (
                        src &&
                        !src.startsWith("blob:") &&
                        !src.startsWith("data:")
                    ) {
                        try {
                            const resolvedPath = resolveRelativePath(
                                src,
                                epubContent.basePath
                            );

                            const manifestItem = Object.values(
                                epubContent.manifest
                            ).find((item) => item.href.includes(resolvedPath));

                            img.setAttribute(
                                "data-original-src",
                                manifestItem?.href as string
                            );
                            const dataUrl = await loadImage(
                                manifestItem?.href as string
                            );
                            img.src = dataUrl;
                        } catch (error) {
                            img.src =
                                'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Cpath fill="%23eee" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/%3E%3C/svg%3E';
                            img.alt = "Failed to load image";
                        }
                    }
                }
            );

            // const start = performance.now();
            await Promise.all(imagePromises);
            // const end = performance.now();
            // const durationInSeconds = ((end - start) / 1000).toFixed(2);
            // console.log(`Image promises took ${durationInSeconds} seconds to complete.`);
            doc.querySelectorAll("script").forEach((script) => script.remove());

            const textBlocks: TextBlock[] = [];
            Array.from(doc.body.children).forEach((child, idx) => {
                // here i can add identifiers to each text element that i could then use to register the progress of a user on a book
                // child.classList.add("just-id");
                const blockElement = document.createElement("div");

                blockElement.innerHTML = child.outerHTML;
                textBlocks.push({
                    id: `${chapterId}-block-${idx}`,
                    content: child.outerHTML,
                    element: blockElement,
                });
            });

            return textBlocks;
        },
        [epubContent, loadImage, loadCssContent]
    );

    const loadChapter = useCallback(
        async (id: string): Promise<Chapter | null> => {
            if (!epubContent || !zipData) return null;
            try {
                const manifestItem = epubContent.manifest[id];
                if (!manifestItem) {
                    throw new Error(`Manifest item not found for id: ${id}`);
                }

                const fullPath = `${epubContent.basePath}${manifestItem.href}`;
                const file = zipData.file(fullPath);

                if (!file) {
                    throw new Error(`File not found in EPUB: ${fullPath}`);
                }

                const content = await file.async("text");
                const baseUrl = `${window.location.origin}/${epubContent.basePath}`;
                const textBlocks = await processHtml(content, baseUrl, id);

                const newHref = manifestItem.href.includes(".")
                    ? manifestItem.href.substring(
                          0,
                          manifestItem.href.lastIndexOf(".")
                      )
                    : manifestItem.href;

                return {
                    id,
                    content: content,
                    hrefId: newHref,
                    textBlocks,
                };
                // const newHref = manifestItem.href.includes(".")
                // 	? manifestItem.href.substring(0, manifestItem.href.lastIndexOf("."))
                // 	: manifestItem.href;

                // return { id, content, element, hrefId: newHref };
            } catch (err) {
                console.warn(`Failed to load chapter ${id}:`, err);
                return null;
            }
        },
        [epubContent, zipData, processHtml]
    );

    const loadAllChapters = useCallback(async () => {
        if (!epubContent) {
            dispatch({
                type: "LOAD_ERROR",
                payload: "No EPUB content available",
            });
            return;
        }

        if (!state.chapters.length && !state.isLoading) {
            dispatch({ type: "START_LOADING" });
            try {
                const chapterPromises = epubContent.spine.map((id) =>
                    loadChapter(id)
                );
                const loadedChapters = await Promise.all(chapterPromises);
                const validChapters = loadedChapters.filter(
                    (ch): ch is Chapter => ch !== null
                );

                const flatTextBlocks = validChapters.flatMap(
                    (chapter) => chapter.textBlocks
                );

                dispatch({
                    type: "LOAD_SUCCESS",
                    payload: {
                        chapters: validChapters,
                        flatTextBlocks,
                    },
                });
            } catch (err) {
                dispatch({
                    type: "LOAD_ERROR",
                    payload:
                        err instanceof Error
                            ? err.message
                            : "Failed to load chapters",
                });
            }
        }
    }, [epubContent, loadChapter, state.chapters.length]);

    return {
        chapters: state.chapters,
        isLoading: state.isLoading,
        error: state.error,
        loadAllChapters,
        flatTextBlocks: state.flatTextBlocks,
    };
};
