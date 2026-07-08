import React, { useEffect, useRef, memo } from "react";
import { Menu, MessageCirclePlus } from "lucide-react";
import Sidebar from "./Sidebar";
import { useEpubProcessor } from "@/hooks/useEpubProcessor";
import { useChapterLoader } from "@/hooks/useChapterLoader";
import { useTextBlockNavigation } from "@/hooks/useTextBlockNavigation";
import { useTextSelection } from "@/hooks/useTextSelection";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import Chapter from "./Chapter";
import type { Chapter as EpubChapter } from "@/hooks/useChapterLoader";
import { findChapterByHref } from "@/lib/epubNavigation";

interface EpubReaderProps {
    url: string;
    bookId: string | null;
    onAddHighlightContext?: (text: string) => void;
}

const EpubReader = memo(
    ({ url, bookId, onAddHighlightContext }: EpubReaderProps) => {
        const { processEpub, isLoading, error, epubContent, zipData } =
            useEpubProcessor();
        const contentRef = useRef<HTMLDivElement>(null);
        const {
            tooltipRef,
            tooltipPosition,
            isVisible: isSelectionActionVisible,
            selectedText,
            clearSelection,
        } = useTextSelection({
            containerRef: contentRef,
            enabled: Boolean(onAddHighlightContext),
        });
        const { chapters, loadAllChapters, flatTextBlocks } = useChapterLoader(
            epubContent,
            zipData
        );
        const [activeChapter, setActiveChapter] =
            React.useState<EpubChapter | null>(null);
        const [isSidebarOpen, setIsSidebarOpen] = React.useState(false);
        const [activeHref, setActiveHref] = React.useState<string | null>(null);
        const { activeTextBlockId, isLoading: textBlockIsLoading } =
            useTextBlockNavigation(flatTextBlocks, contentRef, bookId);

        const handleTocItemClick = (hrefId: string) => {
            const targetChapter = findChapterByHref(chapters, hrefId);
            if (!targetChapter) {
                console.warn(`No chapter found for TOC href: ${hrefId}`);
                return;
            }

            setActiveChapter(targetChapter);
            setActiveHref(hrefId);
            setTimeout(() => {
                contentRef.current?.parentElement?.scrollTo({
                    top: 0,
                    behavior: "smooth",
                });
            }, 100);
        };

        useEffect(() => {
            processEpub(url);
        }, [url, processEpub]);

        useEffect(() => {
            if (epubContent && zipData) {
                loadAllChapters();
            }
        }, [epubContent, zipData, loadAllChapters]);

        // Set initial activeHref based on activeTextBlockId
        useEffect(() => {
            if (
                !textBlockIsLoading &&
                activeTextBlockId &&
                chapters.length > 0
            ) {
                const chapterId = activeTextBlockId.split("-")[0];
                const chapter = chapters.find(
                    (c) =>
                        c.hrefId.includes(chapterId) || c.id.includes(chapterId)
                );
                if (chapter && !activeHref) {
                    setActiveChapter(chapter);
                    setActiveHref(chapter.hrefId);
                    // Give time for the chapter to render before scrolling
                    setTimeout(() => {
                        const element =
                            document.getElementById(activeTextBlockId);
                        if (element) {
                            element.scrollIntoView({
                                behavior: "smooth",
                                block: "center",
                            });
                        }
                    }, 100);
                }
            }
        }, [textBlockIsLoading, activeTextBlockId, chapters]);

        if (isLoading) {
            return (
                <div className="loading-spinner">
                    <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-t-blue-500 border-r-blue-500 border-b-transparent border-l-transparent" />
                    <div className="mt-4 text-lg text-gray-600">
                        Loading book...
                    </div>
                </div>
            );
        }

        if (error) {
            return <div className="p-4 text-red-600">{error}</div>;
        }

        if (!epubContent || !zipData) {
            return null;
        }

        return (
            <>
                <Sidebar
                    epubContent={epubContent}
                    isOpen={isSidebarOpen}
                    onClose={() => setIsSidebarOpen(false)}
                    onTocItemClick={handleTocItemClick}
                    activeHref={activeHref}
                />

                <div className="relative h-full overflow-x-hidden bg-[#f9f9f9]">
                    <div className="sticky left-0 right-0 top-0 z-50 flex h-[72px] items-center bg-[#f9f9f9] px-6 md:px-10">
                        <button
                            className="z-40 cursor-pointer rounded-lg border-none bg-transparent p-2 text-[#47464c] opacity-80 transition-colors duration-200 hover:bg-[#eeeeee] hover:text-[#1f202b]"
                            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                        >
                            <Menu className="h-6 w-6" />
                        </button>
                    </div>
                    <div className="mx-auto max-h-[calc(100%-72px)] max-w-[720px] overflow-y-auto overflow-x-hidden px-5 md:px-10">
                        <div className="pb-32" ref={contentRef}>
                            {isLoading ||
                            textBlockIsLoading ||
                            !activeChapter ? (
                                <LoadingSpinner />
                            ) : (
                                <Chapter
                                    activeTextblockId={activeTextBlockId}
                                    chapter={activeChapter}
                                    isLastChapter={false}
                                    onNextChapter={() => {
                                        const nextChapter = chapters.findIndex(
                                            (ch) => ch.id === activeChapter.id
                                        );
                                        setActiveChapter(
                                            chapters[nextChapter + 1]
                                        );
                                        setTimeout(() => {
                                            contentRef.current?.scrollIntoView({
                                                behavior: "smooth",
                                            });
                                        }, 100);
                                    }}
                                />
                            )}
                        </div>
                        {onAddHighlightContext &&
                            isSelectionActionVisible &&
                            selectedText && (
                                <div
                                    ref={tooltipRef}
                                    className="fixed z-[80]"
                                    style={{
                                        left: tooltipPosition.x,
                                        top: Math.max(16, tooltipPosition.y),
                                    }}
                                >
                                    <button
                                        type="button"
                                        onMouseDown={(event) =>
                                            event.preventDefault()
                                        }
                                        onClick={() => {
                                            onAddHighlightContext(selectedText);
                                            clearSelection();
                                        }}
                                        className="inline-flex items-center gap-2 rounded-full bg-[#343541] px-3 py-2 text-xs font-semibold text-white shadow-[0px_10px_30px_rgba(0,0,0,0.22)] transition-colors hover:bg-[#25262d]"
                                    >
                                        <MessageCirclePlus className="h-4 w-4" />
                                        <span>Add to chat</span>
                                    </button>
                                </div>
                            )}
                    </div>
                </div>
            </>
        );
    }
);

EpubReader.displayName = "EpubReader";

export default EpubReader;
