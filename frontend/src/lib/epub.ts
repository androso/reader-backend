import ePub from "epubjs";

export function initReader(element: HTMLElement, bookId: string) {
    const book = ePub(`/api/books/${bookId}`);

    const rendition = book.renderTo(element, {
        width: "100%",
        height: "100%",
        spread: "none",
    });
    rendition.themes.font;
    rendition.display();

    // Add keyboard navigation
    const keyListener = (e: KeyboardEvent) => {
        if (e.key === "ArrowLeft") {
            rendition.prev();
        }
        if (e.key === "ArrowRight") {
            rendition.next();
        }
    };

    document.addEventListener("keyup", keyListener);

    return () => {
        document.removeEventListener("keyup", keyListener);
        book.destroy();
    };
}
