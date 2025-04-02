import React, { useEffect, useRef, memo } from "react";
import { Menu } from "lucide-react";
import Sidebar from "./Sidebar";
import { useEpubProcessor } from "../../hooks/useEpubProcessor";
import { useChapterLoader } from "../../hooks/useChapterLoader";
import { useTextBlockNavigation } from "../../hooks/useTextBlockNavigation";
import { LoadingSpinner } from "../ui/LoadingSpinner";
import Chapter from "./Chapter";

interface EpubReaderProps {
    url: string;
}

const EpubReader: React.FC<EpubReaderProps> = memo(({ url }) => {
    const { processEpub, isLoading, error, epubContent, zipData } =
        useEpubProcessor();
    const contentRef = useRef<HTMLDivElement>(null);
    const { chapters, loadAllChapters, flatTextBlocks } = useChapterLoader(
        epubContent,
        zipData
    );
    const [activeChapter, setActiveChapter] = React.useState<any>(null);
    const [isSidebarOpen, setIsSidebarOpen] = React.useState(false);
    const [activeHref, setActiveHref] = React.useState<string | null>(null);
    const { activeTextBlockId, isLoading: textBlockIsLoading } =
        useTextBlockNavigation(flatTextBlocks, contentRef);

    const handleTocItemClick = (hrefId: string) => {
        const targetChapter = chapters.find((chapter) =>
            chapter.hrefId.includes(hrefId)
        );
        setActiveChapter(targetChapter);
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
        if (!textBlockIsLoading && activeTextBlockId && chapters.length > 0) {
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

            <div className="h-full relative overflow-x-hidden">
                <div className="sticky top-0 left-0 right-0 p-4 bg-white z-50 h-[8%]">
                    <button
                        className="bg-transparent border-none cursor-pointer z-40 hover:bg-gray-100 transition-colors duration-200 rounded"
                        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                    >
                        <Menu className="h-6 w-6" />
                    </button>
                </div>
                <div className="max-w-3xl mx-auto px-6 max-h-[92%] overflow-y-auto overflow-x-hidden">
                    <div className="pb-32" ref={contentRef}>
                        {/* Tooltip */}
                        {/* <div
                            ref={tooltipRef}
                            className={`fixed bg-gray-800 text-white px-3 py-2 rounded shadow-lg transition-opacity duration-200 pointer-events-none ${
                                isVisible ? "opacity-100" : "opacity-0"
                            }`}
                            style={{
                                left: `${tooltipPosition.x}px`,
                                top: `${tooltipPosition.y}px`,
                            }}
                        >
                            hello
                        </div> */}
                        {isLoading || textBlockIsLoading || !activeChapter ? (
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
                                    setActiveChapter(chapters[nextChapter + 1]);
                                    setTimeout(() => {
                                        contentRef.current?.scrollIntoView({
                                            behavior: "smooth",
                                        });
                                    }, 100);
                                }}
                            />
                        )}
                    </div>
                </div>
            </div>
        </>
    );
});

EpubReader.displayName = "EpubReader";

export default EpubReader;
