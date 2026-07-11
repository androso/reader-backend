export type ChapterLike = {
    id: string;
};

export type TextBlockLike = {
    id: string;
};

export const getNextChapter = <TChapter extends ChapterLike>(
    chapters: TChapter[],
    activeChapter: ChapterLike | null
): TChapter | null => {
    if (!activeChapter) return null;

    const activeChapterIndex = chapters.findIndex(
        (chapter) => chapter.id === activeChapter.id
    );
    if (activeChapterIndex < 0 || activeChapterIndex >= chapters.length - 1) {
        return null;
    }

    return chapters[activeChapterIndex + 1] ?? null;
};

export const isLastChapter = (
    chapters: ChapterLike[],
    activeChapter: ChapterLike | null
) => getNextChapter(chapters, activeChapter) === null;

export const getTextBlockNavigationTarget = <TTextBlock extends TextBlockLike>(
    flatTextBlocks: TTextBlock[],
    activeTextBlockId: string | null,
    key: "ArrowDown" | "ArrowUp"
): TTextBlock | null => {
    if (flatTextBlocks.length === 0) return null;

    const currentIndex = flatTextBlocks.findIndex(
        (block) => block.id === activeTextBlockId
    );
    if (currentIndex < 0) return flatTextBlocks[0] ?? null;

    const lastIndex = flatTextBlocks.length - 1;
    const targetIndex =
        key === "ArrowDown"
            ? Math.min(currentIndex + 1, lastIndex)
            : Math.max(currentIndex - 1, 0);

    if (targetIndex === currentIndex) return null;

    return flatTextBlocks[targetIndex] ?? null;
};
