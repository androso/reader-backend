import { memo } from "react";
import TextBlock from "./TextBlock";

const Chapter = memo(
    ({
        chapter,
        activeTextblockId,
        onNextChapter,
        isLastChapter,
    }: {
        chapter: any;
        activeTextblockId: string | null;
        onNextChapter: () => void;
        isLastChapter: boolean;
    }) => (
        <div id={chapter.hrefId}>
            {chapter.textBlocks.map((textBlock: any) => (
                <TextBlock
                    key={textBlock.id}
                    id={textBlock.id}
                    content={textBlock.content}
                    isActive={activeTextblockId === textBlock.id}
                />
            ))}
            {!isLastChapter && (
                <div className="flex justify-center py-8">
                    <button
                        onClick={onNextChapter}
                        className="bg-blue-500 hover:bg-blue-600 text-white rounded-full p-3 transition-colors"
                        aria-label="Next Chapter"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="24"
                            height="24"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M7 13l5 5 5-5" />
                            <path d="M7 6l5 5 5-5" />
                        </svg>
                    </button>
                </div>
            )}
        </div>
    )
);

Chapter.displayName = "Chapter";
export default Chapter;
