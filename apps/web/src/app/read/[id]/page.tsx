"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import EpubReader from "@/components/reader/EpubReader";
import PdfReader from "@/components/reader/PdfReader";
import { useWindowSize } from "@/hooks/useWindowSize";
import { ChatInterface } from "@/components/reader/ChatInterface";
import { ArrowLeft, ArrowLeftRight, GripVertical } from "lucide-react";
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type PointerEvent,
} from "react";
import type { HighlightContext } from "@/types/highlightContext";

type ChatSidebarSide = "left" | "right";

const CHAT_SIDEBAR_STORAGE_KEY = "reader.chatSidebarSide";
const CHAT_PANE_WIDTH_STORAGE_KEY = "reader.chatPaneWidthPercent";
const DEFAULT_CHAT_PANE_WIDTH_PERCENT = 40;
const CHAT_PANE_MIN_WIDTH_PX = 360;
const VIEWER_PANE_MIN_WIDTH_PX = 420;
const CHAT_PANE_MAX_WIDTH_PERCENT = 70;
const KEYBOARD_RESIZE_STEP_PERCENT = 5;

const isChatSidebarSide = (value: string | null): value is ChatSidebarSide =>
    value === "left" || value === "right";

export default function Reader() {
    const router = useRouter();
    const params = useParams();
    const bookFileKey = params.id as string | null;
    const { width } = useWindowSize();
    const isMobile = width < 768;
    const searchParams = useSearchParams();
    const bookId = searchParams.get("bookId");
    const fileType = searchParams.get("type");
    const [highlightContext, setHighlightContext] =
        useState<HighlightContext | null>(null);
    const [chatSidebarSide, setChatSidebarSideState] =
        useState<ChatSidebarSide>("left");
    const [chatPaneWidthPercent, setChatPaneWidthPercentState] = useState(
        DEFAULT_CHAT_PANE_WIDTH_PERCENT
    );
    const [isResizingChatPane, setIsResizingChatPane] = useState(false);
    const readerShellRef = useRef<HTMLDivElement>(null);
    const isResizingChatPaneRef = useRef(false);
    const isPdf = fileType === "pdf" || bookFileKey?.startsWith("pdf-");
    const bookUrl = `${process.env.NEXT_PUBLIC_API_URL}/api/books/${bookFileKey}`;

    const getShellSizing = useCallback(() => {
        const shell = readerShellRef.current;
        if (!shell || typeof window === "undefined") return null;

        const rect = shell.getBoundingClientRect();
        const styles = window.getComputedStyle(shell);
        const gap = parseFloat(styles.columnGap || styles.gap || "0") || 0;
        const availableWidth = Math.max(1, rect.width - gap);

        return {
            availableWidth,
            rect,
        };
    }, []);

    const getChatPaneWidthBounds = useCallback(() => {
        const shellSizing = getShellSizing();
        if (!shellSizing) {
            return {
                min: 0,
                max: CHAT_PANE_MAX_WIDTH_PERCENT,
            };
        }

        const min = Math.min(
            CHAT_PANE_MAX_WIDTH_PERCENT,
            (CHAT_PANE_MIN_WIDTH_PX / shellSizing.availableWidth) * 100
        );
        const max = Math.min(
            CHAT_PANE_MAX_WIDTH_PERCENT,
            ((shellSizing.availableWidth - VIEWER_PANE_MIN_WIDTH_PX) /
                shellSizing.availableWidth) *
                100
        );

        return {
            min,
            max: Math.max(min, max),
        };
    }, [getShellSizing]);

    const clampChatPaneWidthPercent = useCallback(
        (
            widthPercent: number,
            fallbackWidthPercent = DEFAULT_CHAT_PANE_WIDTH_PERCENT
        ) => {
            if (!Number.isFinite(widthPercent)) {
                return fallbackWidthPercent;
            }

            const { min, max } = getChatPaneWidthBounds();
            return Math.min(Math.max(widthPercent, min), max);
        },
        [getChatPaneWidthBounds]
    );

    const setChatPaneWidthPercent = (widthPercent: number) => {
        const nextWidth = clampChatPaneWidthPercent(
            widthPercent,
            chatPaneWidthPercent
        );

        setChatPaneWidthPercentState(nextWidth);
        localStorage.setItem(CHAT_PANE_WIDTH_STORAGE_KEY, String(nextWidth));
    };

    useEffect(() => {
        const storedSide = localStorage.getItem(CHAT_SIDEBAR_STORAGE_KEY);
        if (isChatSidebarSide(storedSide)) {
            setChatSidebarSideState(storedSide);
        }

        const storedWidthValue = localStorage.getItem(
            CHAT_PANE_WIDTH_STORAGE_KEY
        );
        const storedWidth =
            storedWidthValue === null ? null : Number(storedWidthValue);
        if (storedWidth !== null && Number.isFinite(storedWidth)) {
            setChatPaneWidthPercentState((currentWidth) =>
                clampChatPaneWidthPercent(storedWidth, currentWidth)
            );
        }
    }, [clampChatPaneWidthPercent]);

    useEffect(() => {
        setChatPaneWidthPercentState((currentWidth) =>
            clampChatPaneWidthPercent(currentWidth, currentWidth)
        );
    }, [clampChatPaneWidthPercent, width]);

    const setChatSidebarSide = (side: ChatSidebarSide) => {
        setChatSidebarSideState(side);
        localStorage.setItem(CHAT_SIDEBAR_STORAGE_KEY, side);
    };

    const toggleChatSidebarSide = () => {
        setChatSidebarSide(chatSidebarSide === "left" ? "right" : "left");
    };

    const handleBack = () => {
        if (window.history.length > 1) {
            router.back();
            return;
        }

        router.push("/");
    };

    const resizeChatPaneFromPointer = (clientX: number) => {
        const shellSizing = getShellSizing();
        if (!shellSizing) return;

        const chatWidthPx =
            chatSidebarSide === "left"
                ? clientX - shellSizing.rect.left
                : shellSizing.rect.right - clientX;

        setChatPaneWidthPercent(
            (chatWidthPx / shellSizing.availableWidth) * 100
        );
    };

    const handleResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;

        event.preventDefault();
        isResizingChatPaneRef.current = true;
        setIsResizingChatPane(true);
        resizeChatPaneFromPointer(event.clientX);
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handleResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        if (!isResizingChatPaneRef.current) return;

        resizeChatPaneFromPointer(event.clientX);
    };

    const handleResizePointerUp = (event: PointerEvent<HTMLDivElement>) => {
        isResizingChatPaneRef.current = false;
        setIsResizingChatPane(false);

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    const handleResizePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
        isResizingChatPaneRef.current = false;
        setIsResizingChatPane(false);

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    const resetChatPaneWidth = () => {
        setChatPaneWidthPercent(DEFAULT_CHAT_PANE_WIDTH_PERCENT);
    };

    const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            const direction = event.key === "ArrowRight" ? 1 : -1;
            const chatSideMultiplier = chatSidebarSide === "left" ? 1 : -1;
            setChatPaneWidthPercent(
                chatPaneWidthPercent +
                    direction *
                        chatSideMultiplier *
                        KEYBOARD_RESIZE_STEP_PERCENT
            );
        }
    };

    const widthBounds = getChatPaneWidthBounds();

    const desktopChatPane = (
        <div
            key="desktop-chat-pane"
            className={`relative min-w-[360px] shrink-0 overflow-visible ${
                chatSidebarSide === "left" ? "order-1" : "order-3"
            }`}
            style={{ flexBasis: `${chatPaneWidthPercent}%` }}
        >
            <div className="h-full overflow-hidden rounded-xl bg-[#343541]">
                <ChatInterface
                    isMobile={false}
                    bookId={bookId ?? ""}
                    onBack={handleBack}
                    highlightContext={highlightContext}
                    onClearHighlightContext={() => setHighlightContext(null)}
                />
            </div>
            <div
                className={`absolute top-1/2 z-[75] flex w-7 -translate-y-1/2 flex-col items-center gap-1 rounded-full border border-white/10 bg-[#2b2c32] p-1 text-white/75 shadow-lg ${
                    chatSidebarSide === "left" ? "-right-3.5" : "-left-3.5"
                }`}
            >
                <button
                    type="button"
                    onClick={toggleChatSidebarSide}
                    aria-label={`Move chat sidebar ${chatSidebarSide === "left" ? "right" : "left"}`}
                    title={`Move chat sidebar ${chatSidebarSide === "left" ? "right" : "left"}`}
                    className="flex h-6 w-6 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                >
                    <ArrowLeftRight className="h-3.5 w-3.5" />
                </button>
                <div
                    role="separator"
                    aria-label="Resize chat and book panels"
                    aria-orientation="vertical"
                    aria-valuemin={Math.round(widthBounds.min)}
                    aria-valuemax={Math.round(widthBounds.max)}
                    aria-valuenow={Math.round(chatPaneWidthPercent)}
                    tabIndex={0}
                    onPointerDown={handleResizePointerDown}
                    onPointerMove={handleResizePointerMove}
                    onPointerUp={handleResizePointerUp}
                    onPointerCancel={handleResizePointerCancel}
                    onDoubleClick={resetChatPaneWidth}
                    onKeyDown={handleResizeKeyDown}
                    className={`flex h-14 w-6 touch-none items-center justify-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-white/35 ${
                        isResizingChatPane
                            ? "cursor-col-resize bg-white/15 text-white"
                            : "cursor-col-resize hover:bg-white/10 hover:text-white"
                    }`}
                    title="Drag to resize panels. Double-click to reset."
                >
                    <GripVertical className="h-4 w-4" />
                </div>
            </div>
        </div>
    );

    const desktopViewerPane = (
        <div
            key="desktop-viewer-pane"
            className="relative order-2 min-w-[420px] flex-1 overflow-hidden rounded-xl bg-[#f9f9f9]"
        >
            {isPdf ? (
                <PdfReader url={bookUrl} />
            ) : (
                <EpubReader
                    url={bookUrl}
                    onAddHighlightContext={(text) =>
                        setHighlightContext({
                            sourceType: "epub",
                            text,
                        })
                    }
                />
            )}
        </div>
    );

    return (
        <div className="min-h-[100dvh] bg-[#2b2b31] p-0 text-[#1a1c1c] md:flex md:items-center md:justify-center md:p-[2.5dvh]">
            <div
                ref={readerShellRef}
                className={`relative flex h-[100dvh] w-full overflow-hidden bg-transparent shadow-2xl md:h-[95dvh] md:w-[95vw] md:gap-3 md:rounded-xl ${
                    isMobile ? "flex-col" : "justify-center"
                } ${isResizingChatPane ? "select-none" : ""}`}
            >
                {isMobile ? (
                    <div className="relative h-full w-full overflow-hidden bg-[#f9f9f9]">
                        <button
                            type="button"
                            onClick={handleBack}
                            className="absolute left-4 top-4 z-[70] flex h-11 w-11 items-center justify-center rounded-full bg-[#343541]/90 text-white shadow-lg transition-colors hover:bg-[#343541]"
                            aria-label="Back to library"
                        >
                            <ArrowLeft className="h-5 w-5" />
                        </button>
                        {isPdf ? (
                            <PdfReader url={bookUrl} />
                        ) : (
                            <EpubReader url={bookUrl} />
                        )}
                        <ChatInterface isMobile={true} bookId={bookId ?? ""} />
                    </div>
                ) : (
                    <>
                        {desktopChatPane}
                        {desktopViewerPane}
                    </>
                )}
            </div>
        </div>
    );
}
