import { useRef, useState } from "react";
import { ReactReader } from "@/components/reader/ReactReader/ReactReader";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import useSelectionTooltip from "@/hooks/useSelectionTooltip";
import TextSelectionTooltip from "./ui/TextSelectionTooltip";
import type { Rendition, Contents } from "epubjs";
interface BookViewerProps {
    bookId: string;
}

export function BookViewer({ bookId }: BookViewerProps) {
    // location helps keep redirect to a new section
    // we set it to 1 in order to avoid showing the book cover
    const [location, setLocation] = useState<string | number>(1);
    const { toast } = useToast();
    const { handleMouseDown, handleSelection, showTooltip, tooltipPosition } =
        useSelectionTooltip({
            minDragDistance: 5,
            tooltipOffset: 0,
        });

    // ref to the rendition element from epubjs
    const renditionRef = useRef<Rendition | null>(null);

    return (
        <div
            className="w-[49%] max-w-[669px]  h-full"
            style={{ height: "100%", position: "relative" }}
        >
            {showTooltip && (
                <TextSelectionTooltip position={tooltipPosition}>
                    test
                </TextSelectionTooltip>
            )}
            <ReactReader
                url={`/api/books/${bookId}`}
                location={location}
                locationChanged={(loc: string | number) => setLocation(loc)}
                showToc={true}
                loadingView={<div className="p-4">Loading EPUB file...</div>}
                getRendition={(rendition) => {
                    renditionRef.current = rendition;
                    rendition.hooks.content.register((contents: Contents) => {
                        const document = contents.window.document;
                        if (document) {
                            const css = `
                @font-face {
                  font-family: "literata";
                  font-weight: 200 900;
                  src: url("/fonts/literata-variable.ttf") format("truetype-variations");
                }
                `;
                            const style = document.createElement("style");
                            style.appendChild(document.createTextNode(css));
                            document.head.appendChild(style);
                            rendition.themes.override(
                                "font-family",
                                "literata"
                            );
                        }
                    });

                    rendition.on("started", () => {
                        // console.log("EPUB started loading");
                    });
                    rendition.on("displayed", () => {
                        // console.log("EPUB page displayed");
                    });
                    rendition.on("rendered", () => {
                        // console.log("EPUB content rendered");
                        const contents = rendition.getContents();

                        if (contents) {
                            const content = contents[0] as any;
                            content.document.addEventListener(
                                "mousedown",
                                (e) => {
                                    handleMouseDown(e);
                                }
                            );
                            content.document.addEventListener(
                                "mouseup",
                                (e) => {
                                    handleSelection(e, content.document);
                                }
                            );
                        }
                    });
                }}
            />
        </div>
    );
}
