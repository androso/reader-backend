import React, { useEffect, useRef } from "react";
import { Menu } from "lucide-react";
import Sidebar from "./Sidebar";
import { useEpubProcessor } from "../../hooks/useEpubProcessor";
import { useChapterLoader } from "../../hooks/useChapterLoader";
import { useTextBlockNavigation } from "../../hooks/useTextBlockNavigation";
import Chapter from "./Chapter";

interface EpubReaderProps {
    url: string;
}

// what needs to be modified?
// why do we have activeHref and activeChapter states? are they redundant?
// abstract the hook that loads the book the reader left off
const EpubReader: React.FC<EpubReaderProps> = ({ url }) => {
    const contentRef = useRef<HTMLDivElement>(null);
    const { processEpub, isLoading, error, epubContent, zipData } =
        useEpubProcessor();
    const { chapters, loadAllChapters, flatTextBlocks } = useChapterLoader(
        epubContent,
        zipData
    );
    const {
        activeTextBlockId,
        isLoading: textBlockIsLoading,
        setActiveChapter,
        activeChapter,
        activeHref,
    } = useTextBlockNavigation(flatTextBlocks, contentRef, chapters);
    const [isSidebarOpen, setIsSidebarOpen] = React.useState(false);
    
    const handleTocItemClick = (hrefId: string) => {
        const targetChapter = chapters.find((chapter) =>
            chapter.hrefId.includes(hrefId)
        );
        setActiveChapter(targetChapter);
    };

    // process epub "metadata" on initial load
    useEffect(() => {
        processEpub(url);
    }, [url, processEpub]);

    // process chapters data after epub was processed
    useEffect(() => {
        if (epubContent && zipData) {
            loadAllChapters();
        }
    }, [epubContent, zipData, loadAllChapters]);

    if (error) {
        return <div className="p-4 text-red-600">{error}</div>;
    }

    if (!epubContent || !zipData) {
        return null;
    }

    return (
        <>
            {/* Table of contents */}
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
                        {isLoading || textBlockIsLoading || !activeChapter ? (
                            "loading"
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
};

EpubReader.displayName = "EpubReader";

export default EpubReader;
