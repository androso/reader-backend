import { Bookmark, MessageCircle, Share2 } from "lucide-react";
import React, { memo } from "react";

const TextBlock = memo(
    ({
        id,
        content,
        isActive,
    }: {
        id: string;
        content: string;
        isActive: boolean;
    }) => {
        const [offset, setOffset] = React.useState(0);
        const [isDragging, setIsDragging] = React.useState(false);
        const [startX, setStartX] = React.useState(0);
        const [isLocked, setIsLocked] = React.useState(false);
        const dragThreshold = 80;

        const handleDragStart = (e: React.MouseEvent | React.TouchEvent) => {
            const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
            setStartX(clientX);
            if (!isLocked) {
                setIsDragging(true);
            }
        };

        const handleDragMove = (e: React.MouseEvent | React.TouchEvent) => {
            if (!isDragging || isLocked) return;
            const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
            const deltaX = clientX - startX;
            setOffset(Math.min(Math.max(0, deltaX), 100));
        };

        const handleDragEnd = () => {
            setIsDragging(false);
            if (offset > dragThreshold) {
                setOffset(100);
                setIsLocked(true);
            } else {
                setOffset(0);
            }
        };

        const handleUnlock = () => {
            setIsLocked(false);
            setOffset(0);
        };

        const handleParagraphClick = (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (isLocked) {
                handleUnlock();
            }
        };

        const renderActionIcons = () => {
            if (!isLocked && offset === 0) return null;
            const opacity = Math.min((offset / dragThreshold) * 1.2, 1);
            const scale = 0.6 + opacity * 0.4;

            return (
                <div className="absolute left-0 top-0 h-full flex flex-col items-center justify-center gap-2 pl-4">
                    <button
                        className="p-2 bg-blue-100 rounded-full hover:bg-blue-200 transition-all transform"
                        style={{ opacity, transform: `scale(${scale})` }}
                    >
                        <MessageCircle className="h-5 w-5 text-blue-600" />
                    </button>
                    <button
                        className="p-2 bg-blue-100 rounded-full hover:bg-blue-200 transition-all transform"
                        style={{ opacity, transform: `scale(${scale})` }}
                    >
                        <Bookmark className="h-5 w-5 text-blue-600" />
                    </button>
                    <button
                        className="p-2 bg-blue-100 rounded-full hover:bg-blue-200 transition-all transform"
                        style={{ opacity, transform: `scale(${scale})` }}
                    >
                        <Share2 className="h-5 w-5 text-blue-600" />
                    </button>
                </div>
            );
        };

        return (
            <div
                id={id}
                className={`transition-all transform select-none cursor-grab active:cursor-grabbing relative  `}
            >
                <div
                    className="absolute inset-0 z-10"
                    onMouseDown={handleDragStart}
                    onTouchStart={(e) => {
                        const touch = e.touches[0];
                        setStartX(touch.clientX);
                    }}
                    onMouseMove={handleDragMove}
                    onTouchMove={(e) => {
                        if (
                            !isDragging &&
                            Math.abs(e.touches[0].clientX - startX) > 10
                        ) {
                            setIsDragging(true);
                            e.preventDefault();
                        }
                        if (isDragging) {
                            e.preventDefault();
                            handleDragMove(e);
                        }
                    }}
                    onMouseUp={handleDragEnd}
                    onTouchEnd={handleDragEnd}
                    onMouseLeave={handleDragEnd}
                    style={{
                        touchAction: isDragging ? "none" : "pan-y",
                    }}
                />
                <div className="relative">
                    {renderActionIcons()}
                    <div
                        className={`mb-4 p-4 relative z-10 ${
                            isActive
                                ? "border-l-4 border-blue-500 bg-blue-50"
                                : "border-l-4 border-transparent"
                        } ${isDragging || isLocked ? "shadow-lg" : "shadow-sm"} ${
                            isLocked ? "cursor-pointer" : ""
                        }`}
                        onClick={handleParagraphClick}
                        style={{
                            transform: `translateX(${offset}px)`,
                            transition: !isDragging
                                ? "transform 0.2s ease-out"
                                : "none",
                            userSelect: "none",
                            pointerEvents: isLocked ? "auto" : "none",
                        }}
                        dangerouslySetInnerHTML={{ __html: content }}
                    />
                </div>
            </div>
        );
    }
);

TextBlock.displayName = "TextBlock";
export default TextBlock;
