import { useCallback, useEffect, useState } from "react";

export const useReadingProgress = (
    contentRef: React.RefObject<HTMLDivElement | null>,
    bookId: string
) => {
    const [progress, setProgress] = useState(() => {
        const saved = localStorage.getItem(`book-progress-${bookId}`);
        return saved ? parseFloat(saved) : 0;
    });

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
        if (!contentRef.current) return;
        const element = contentRef.current.parentElement;
        if (!element) return;

        const savedProgress = localStorage.getItem(`book-progress-${bookId}`);
        let restored = false;
        const restore = () => {
            if (!savedProgress || restored) return;
            const scrollHeight = element.scrollHeight;
            const clientHeight = element.clientHeight;
            const contentHeight = scrollHeight - clientHeight;
            if (contentHeight <= 0) return;
            const progressValue = Math.min(
                Math.max(Number.parseFloat(savedProgress), 0),
                100
            );
            element.scrollTop = (progressValue / 100) * contentHeight;
            restored = true;
        };
        const observer = new ResizeObserver(() =>
            requestAnimationFrame(restore)
        );
        observer.observe(element);
        restore();
        return () => observer.disconnect();
    }, [bookId, contentRef]);

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
    }, [contentRef, calculateProgress]);

    return progress;
};
