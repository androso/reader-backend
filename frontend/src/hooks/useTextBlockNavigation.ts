import { TextBlock } from "../types/EpubReader";
import React, { useCallback, useEffect, useRef, useState } from "react";

export const useTextBlockNavigation = (
    flatTextBlocks: TextBlock[],
    contentRef: React.RefObject<HTMLDivElement | null>,
    chapters: any 
) => {
    const [isLoading, setIsLoading] = useState(true);
    const [activeTextBlockId, setActiveTextBlockId] = useState<string | null>(
        null
    );
    const [activeChapter, setActiveChapter] = useState<any>(null);
    const [activeHref, setActiveHref] = useState<string | null>(null);
    
    // manual scroll == navigation using arrow up and down
    const [isManualScroll, setIsManualScroll] = useState(false);
    const scrollTimeout = useRef<NodeJS.Timeout | null>(null);

    const fetchProgress = async (bookId: string) => {
        try {
            const apiUrl = import.meta.env.VITE_API_URL as string;
            const response = await fetch(
                `${apiUrl}/api/${bookId}/progress`,
                {
                    method: "GET",
                    headers: {
                        Authorization: `Bearer ${localStorage.getItem("token")}`,
                        "Content-Type": "application/json",
                    },
                }
            );
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            // Handle null progressPosition
            if (!data.progressPosition) {
                return null;
            }

            return data.progressPosition;
        } catch (error) {
            console.error("An error ocurred while progress was fetched", error);
            return null;
        }
    };

    //save progress
    const [hasInitialProgress, setHasInitialProgress] = useState(false);

    const saveProgress = async (textBlockId: string) => {
        // console.log("saveProgress", { hasInitialProgress });
        if (!textBlockId) {
            // console.log("no textblock id");
            return;
        }
        const bookId = window.location.pathname.split("/")[2];
        try {
            const apiUrl = import.meta.env.VITE_API_URL as string;
            const response = await fetch(
                `${apiUrl}/api/${bookId}/progress`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${localStorage.getItem("token")}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        progress_block: textBlockId,
                        progress_chapter: textBlockId.split("-")[0], // assuming format like "c01-block-16"
                    }),
                }
            );
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
        } catch (error) {
            console.error("Progress cant be saved", error);
        }
    };

    useEffect(() => {
        if (!activeTextBlockId && flatTextBlocks.length > 0) {
            const bookId = window.location.pathname.split("/")[2];
            const initializeProgress = async () => {
                try {
                    const storedId = await fetchProgress(bookId);
                    if (storedId) {
                        setHasInitialProgress(true);
                    }
                    setActiveTextBlockId(storedId || flatTextBlocks[0].id);
                    const element = document.getElementById(
                        storedId || flatTextBlocks[0].id
                    );
                    if (element) {
                        element.scrollIntoView({
                            behavior: "smooth",
                            block: "center",
                        });
                    }
                } finally {
                    setIsLoading(false);
                }
            };
            //this retrieves the progress from the server
            initializeProgress();
        }
    }, [flatTextBlocks]);

    const getVisibilityRatio = useCallback((element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const $parentElement = contentRef.current?.parentElement;
        const parentRect = $parentElement?.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();

        // adjust coordinates of element relative to parent
        const relativeTop = elementRect.top - parentRect!.top;
        const relativeBottom = elementRect.bottom - parentRect!.top;
        const windowHeight = $parentElement!.clientHeight;

        // If element is not in viewport at all
        if (relativeBottom < 0 || relativeTop > windowHeight) {
            return 0;
        }
        if (
            (relativeTop >= 0 && relativeBottom > windowHeight) ||
            (relativeBottom < windowHeight && relativeTop <= 0)
        ) {
            return 0;
        }

        // Calculate the visible height of the element
        const visibleHeight =
            Math.min(rect.bottom, windowHeight) - Math.max(rect.top, 0);
        const ratio = visibleHeight / rect.height;
        return Math.max(0, Math.min(1, ratio));
    }, []);

    const findMostVisibleBlock = useCallback(() => {
        if (!flatTextBlocks) return null;
        let maxVisibility = 0;
        let mostVisibleId = null;

        for (const block of flatTextBlocks) {
            const element = document.getElementById(block.id);
            if (element) {
                const visibility = getVisibilityRatio(element);
                if (visibility > maxVisibility) {
                    maxVisibility = visibility;
                    mostVisibleId = block.id;
                }
            }
        }

        return mostVisibleId;
    }, [flatTextBlocks, getVisibilityRatio]);

    const handleScroll = useCallback(() => {
        if (!isManualScroll) {
            if (scrollTimeout.current) {
                clearTimeout(scrollTimeout.current);
            }

            scrollTimeout.current = setTimeout(() => {
                const mostVisibleId = findMostVisibleBlock();
                if (mostVisibleId) {
                    // console.log({ mostVisibleId });
                    saveProgress(mostVisibleId);
                    if (mostVisibleId !== activeTextBlockId) {
                        // console.log({ mostVisibleId, activeTextBlockId });
                        setActiveTextBlockId(mostVisibleId);
                    }
                }
            }, 300);
        }
    }, [activeTextBlockId, isManualScroll]);

    // scroll listener
    useEffect(() => {
        const $container = contentRef.current?.parentElement;
        if (!$container) return;
        $container.addEventListener("scroll", handleScroll);

        return () => {
            $container.removeEventListener("scroll", handleScroll);
            if (scrollTimeout.current) {
                clearTimeout(scrollTimeout.current);
            }
        };
    }, [handleScroll]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key == "ArrowDown" || e.key == "ArrowUp") {
                e.preventDefault();
                setIsManualScroll(true);

                const currTextBlockIndex = flatTextBlocks.findIndex(
                    (block) => block.id === activeTextBlockId
                );

                const newIndex =
                    e.key === "ArrowDown"
                        ? Math.min(
                              currTextBlockIndex + 1,
                              flatTextBlocks.length
                          )
                        : Math.max(currTextBlockIndex - 1, 0);

                if (newIndex !== currTextBlockIndex) {
                    const targetBlock = flatTextBlocks[newIndex];
                    setActiveTextBlockId(targetBlock.id);
                    saveProgress(targetBlock.id);
                    document.getElementById(targetBlock.id)?.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                    });
                }

                setTimeout(() => {
                    setIsManualScroll(false);
                }, 300);
            }
        };

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [flatTextBlocks, activeTextBlockId]);

    useEffect(() => {
        if (!isLoading && activeTextBlockId && chapters.length > 0) {
            const chapterId = activeTextBlockId.split("-")[0];
            const chapter = chapters.find(
                (c) => c.hrefId.includes(chapterId) || c.id.includes(chapterId)
            );
            if (chapter && !activeHref) {
                setActiveChapter(chapter);
                setActiveHref(chapter.hrefId);
                // Give time for the chapter to render before scrolling
                setTimeout(() => {
                    const element = document.getElementById(activeTextBlockId);
                    if (element) {
                        element.scrollIntoView({
                            behavior: "smooth",
                            block: "center",
                        });
                    }
                }, 100);
            }
        }
    }, [isLoading, activeTextBlockId, chapters]);
    
    return {
        activeTextBlockId,
        isLoading,
        activeChapter,
        activeHref,
        setActiveChapter
    };
};
