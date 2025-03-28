import { useCallback, useEffect, useState } from "react";

export const useReadingProgress = (
    contentRef: React.RefObject<HTMLDivElement | null>,
    bookId: string
) => {
    const [progress, setProgress] = useState(() => {
        const saved = localStorage.getItem(`book-progress-${bookId}`);
        return saved ? parseFloat(saved) : 0;
    });
    const parentElement = contentRef.current?.parentElement;

    const calculateProgress = useCallback(() => {
        if (!contentRef || !contentRef.current) return;
        const element = contentRef.current.parentElement!;
        const scrollTop = element.scrollTop;
        const scrollHeight = element.scrollHeight;
        const clientHeight = element.clientHeight;
        const contentHeight = scrollHeight - clientHeight;

        if (contentHeight <= 0) return;
        const currentProgress = (scrollTop / contentHeight) * 100;
        const newProgress = Math.min(Math.max(currentProgress, 0), 100);
        setProgress(newProgress);
        localStorage.setItem(`book-progress-${bookId}`, newProgress.toString());
    }, [contentRef, bookId]);

    useEffect(() => {
        if (!contentRef || !contentRef.current) return;
        const element = contentRef.current.parentElement;
        if (!element || element.scrollHeight == element.clientHeight) return;

        const savedProgress = localStorage.getItem(`book-progress-${bookId}`);
        console.log({ savedProgress });
        if (savedProgress) {
            const progressValue = parseFloat(savedProgress);
            const scrollHeight = element.scrollHeight;
            const clientHeight = element.clientHeight;
            const contentHeight = scrollHeight - clientHeight;
            const scrollPosition = (progressValue / 100) * contentHeight;
            console.log({
                scrollHeight,
                clientHeight,
                contentHeight,
                progressValue,
            });
            setTimeout(() => {
                element.scrollTop = scrollPosition;
            }, 0);
        }
    }, [
        bookId,
        contentRef,
        contentRef.current,
        parentElement?.clientHeight,
        parentElement?.scrollHeight,
    ]);

    useEffect(() => {
        if (!contentRef || !contentRef.current) return;
        const element = contentRef.current.parentElement;

        if (!element) return;
        const handleScroll = () => {
            requestAnimationFrame(calculateProgress);
        };

        calculateProgress();

        element.addEventListener("scroll", handleScroll);
        return () => {
            element.removeEventListener("scroll", handleScroll);
        };
    }, [contentRef.current, calculateProgress]);

    return progress;
};
