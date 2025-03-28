import { MousePosition, TooltipPosition } from "@/types/tooltipTypes";
import { useRef, useState } from "react";

export const adjustSelectionToWords = (contentDocument: any): Range | null => {
    const selection = contentDocument.getSelection();
    if (!selection || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);

    const startNode = range.startContainer;
    const endNode = range.endContainer;

    if (
        startNode.nodeType === Node.TEXT_NODE &&
        endNode.nodeType === Node.TEXT_NODE
    ) {
        const startText = startNode.textContent || "";
        const endText = endNode.textContent || "";

        let startOffset = range.startOffset;
        let endOffset = range.endOffset;

        // Adjust start to word boundary
        while (startOffset > 0 && !/\s/.test(startText[startOffset - 1])) {
            startOffset--;
        }

        // Adjust end to word boundary
        while (endOffset < endText.length && !/\s/.test(endText[endOffset])) {
            endOffset++;
        }

        const newRange = range.cloneRange();
        newRange.setStart(startNode, startOffset);
        newRange.setEnd(endNode, endOffset);

        selection.removeAllRanges();
        selection.addRange(newRange);

        return newRange;
    }

    return range;
};

export const calculateDistance = (
    start: MousePosition,
    end: MousePosition
): number => {
    return Math.sqrt(
        Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2)
    );
};

interface UseSelectionTooltipOptions {
    minDragDistance?: number;
    tooltipOffset?: number;
}

export default function useSelectionTooltip({
    minDragDistance = 5,
    tooltipOffset = 40,
}: UseSelectionTooltipOptions) {
    const [showTooltip, setShowTooltip] = useState(false);
    const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition>({
        x: 0,
        y: 0,
    });
    const mouseStartPositionRef = useRef<null | MousePosition>(null);
    const handleMouseDown = (e: MouseEvent) => {
        // register the initial position and avoid creating a tooltip right away
        mouseStartPositionRef.current = { x: e.clientX, y: e.clientY };
        setShowTooltip(false);
    };

    const handleSelection = (e: MouseEvent, contentDocument: any) => {
        if (!mouseStartPositionRef.current) return;
        const distance = calculateDistance(mouseStartPositionRef.current, {
            x: e.clientX,
            y: e.clientY,
        });
        const isDrag = distance > minDragDistance;
        if (!isDrag) {
            setShowTooltip(false);
            mouseStartPositionRef.current = null;
            return;
        }

        const adjustedRange = adjustSelectionToWords(contentDocument);
        if (!adjustedRange) {
            setShowTooltip(false);
            mouseStartPositionRef.current = null;
            return;
        }

        const selection = contentDocument.getSelection();
        if (!selection || selection.toString().trim().length === 0) {
            setShowTooltip(false);
            mouseStartPositionRef.current = null;
            return;
        }

        const rect = adjustedRange.getBoundingClientRect();
        setTooltipPosition({
            x: rect.left + rect.width / 2,
            y: rect.top - tooltipOffset,
        });

        setShowTooltip(true);
        mouseStartPositionRef.current = null;
    };

    return {
        showTooltip,
        tooltipPosition,
        hideTooltip: () => setShowTooltip(false),
        handleMouseDown,
        handleSelection,
    };
}
