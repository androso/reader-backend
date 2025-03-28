import React, { useState, memo } from "react";
import { type EpubContent } from "@/types/EpubReader";

interface SidebarProps {
    epubContent: EpubContent;
    isOpen: boolean;
    onClose: () => void;
}

const Sidebar: React.FC<SidebarProps> = memo(
    ({ epubContent, isOpen, onClose }) => {
        const [expandedItems, setExpandedItems] = useState<Set<string>>(
            new Set()
        );

        const hasChildren = (currentIndex: number) => {
            const currentEntry = epubContent.toc[currentIndex];
            return epubContent.toc.some(
                (entry, i) =>
                    i > currentIndex &&
                    entry.level > currentEntry.level &&
                    !epubContent.toc
                        .slice(currentIndex + 1, i)
                        .some((e) => e.level <= currentEntry.level)
            );
        };

        const handleToggle = (index: number) => {
            setExpandedItems((prev) => {
                const next = new Set(prev);
                if (next.has(index.toString())) {
                    next.delete(index.toString());
                } else {
                    next.add(index.toString());
                }
                return next;
            });
        };

        const renderTocItem = (
            entry: (typeof epubContent.toc)[0],
            index: number
        ) => {
            if (!entry) return null;

            const isExpanded = expandedItems.has(index.toString());
            const hasChildrenItems = hasChildren(index);
            const isVisible =
                entry.level === 0 ||
                epubContent.toc
                    .slice(0, index)
                    .some(
                        (prev, i) =>
                            prev.level < entry.level &&
                            expandedItems.has(i.toString()) &&
                            !epubContent.toc
                                .slice(i + 1, index)
                                .some((item) => item.level <= prev.level)
                    );

            if (!isVisible) return null;

            return (
                <div key={`${entry.id}-${index}`}>
                    <div
                        className={`toc-item level-${entry.level} flex items-center cursor-pointer hover:bg-gray-100 px-2 py-1`}
                        style={{
                            paddingLeft: `${entry.level * 1.5}rem`,
                        }}
                    >
                        {hasChildrenItems && (
                            <button
                                onClick={() => handleToggle(index)}
                                className="bg-none border-none p-1 cursor-pointer mr-1 text-gray-600"
                            >
                                {isExpanded ? "▼" : "▶"}
                            </button>
                        )}
                        <a
                            href={`#${entry.href}`}
                            onClick={onClose}
                            className={`text-decoration-none flex-1 py-1 ${entry.isPage ? "text-gray-600 text-sm" : ""}`}
                        >
                            {entry.title}
                        </a>
                    </div>
                </div>
            );
        };

        return (
            <div
                className={`absolute h-full overflow-x-hidden left-0 bg-white border-r shadow-lg transition-transform duration-300 ease-in-out transform z-30 ${
                    isOpen ? "translate-x-0" : "-translate-x-full"
                }`}
            >
                <div className="w-64 h-full p-4 pt-[4rem]">
                    <div className="">
                        <h3 className="text-lg font-semibold">
                            {epubContent.metadata.title}
                        </h3>
                        <p className="text-gray-600 italic mt-2 mb-4">
                            {epubContent.metadata.creator}
                        </p>
                    </div>
                    <div className="overflow-y-auto h-[calc(100%-7rem)]">
                        <nav className="flex flex-col">
                            {epubContent.toc.map((entry, index) =>
                                renderTocItem(entry, index)
                            )}
                        </nav>
                    </div>
                </div>
            </div>
        );
    }
);

export default Sidebar;
