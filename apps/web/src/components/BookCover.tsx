"use client";

import { useEffect, useState } from "react";
import JSZip from "jszip";
import type { Book } from "@/types/bookTypes";
import { resolveRelativePath } from "@/lib/utils";

interface BookCoverProps {
    book: Book;
    className?: string;
    iconClassName?: string;
}

const imageMimeTypes: Record<string, string> = {
    avif: "image/avif",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
};

const getMimeType = (path: string) => {
    const extension = path.split(".").pop()?.toLowerCase();
    return extension ? imageMimeTypes[extension] ?? "image/jpeg" : "image/jpeg";
};

const getOpfPath = async (zip: JSZip) => {
    const containerXml = await zip
        .file("META-INF/container.xml")
        ?.async("text");
    if (!containerXml) return null;

    const container = new DOMParser().parseFromString(
        containerXml,
        "application/xml"
    );
    return (
        container
            .querySelector("rootfile")
            ?.getAttribute("full-path")
            ?.trim() || null
    );
};

const getCoverPathFromOpf = (opfContent: string) => {
    const opf = new DOMParser().parseFromString(opfContent, "application/xml");
    const coverImageItem = opf.querySelector(
        "manifest > item[properties~='cover-image']"
    );
    if (coverImageItem?.getAttribute("href")) {
        return coverImageItem.getAttribute("href");
    }

    const coverId = opf
        .querySelector("metadata > meta[name='cover']")
        ?.getAttribute("content");
    if (coverId) {
        const coverItem = opf.querySelector(
            `manifest > item[id="${CSS.escape(coverId)}"]`
        );
        if (coverItem?.getAttribute("href")) {
            return coverItem.getAttribute("href");
        }
    }

    return opf
        .querySelector("manifest > item[media-type^='image/']")
        ?.getAttribute("href");
};

const extractEpubCoverUrl = async (file: Blob) => {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const opfPath = await getOpfPath(zip);
    if (!opfPath) return null;

    const opfContent = await zip.file(opfPath)?.async("text");
    if (!opfContent) return null;

    const coverPath = getCoverPathFromOpf(opfContent);
    if (!coverPath) return null;

    const opfBasePath = opfPath.includes("/")
        ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1)
        : "";
    const resolvedCoverPath = resolveRelativePath(coverPath, opfBasePath);
    const coverFile = zip.file(resolvedCoverPath) ?? zip.file(coverPath);
    if (!coverFile) return null;

    const coverBlob = new Blob([await coverFile.async("arraybuffer")], {
        type: getMimeType(resolvedCoverPath),
    });
    return URL.createObjectURL(coverBlob);
};

export default function BookCover({
    book,
    className = "",
    iconClassName = "text-4xl",
}: BookCoverProps) {
    const [coverUrl, setCoverUrl] = useState<string | null>(null);

    useEffect(() => {
        if (book.fileType !== "epub") {
            setCoverUrl(null);
            return;
        }

        let isCancelled = false;
        let objectUrl: string | null = null;

        const loadCover = async () => {
            try {
                const token = localStorage.getItem("token");
                const response = await fetch(
                    `${process.env.NEXT_PUBLIC_API_URL}/api/books/${book.id}`,
                    {
                        headers: {
                            Authorization: `Bearer ${token}`,
                        },
                    }
                );
                if (!response.ok) return;

                objectUrl = await extractEpubCoverUrl(await response.blob());
                if (!isCancelled) {
                    setCoverUrl(objectUrl);
                } else if (objectUrl) {
                    URL.revokeObjectURL(objectUrl);
                }
            } catch (error) {
                console.warn("Failed to load EPUB cover", {
                    bookId: book.id,
                    error,
                });
            }
        };

        loadCover();

        return () => {
            isCancelled = true;
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [book.fileType, book.id]);

    return (
        <div
            className={`relative flex items-center justify-center overflow-hidden bg-surface-container shadow-sm ${className}`}
        >
            {coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={coverUrl}
                    alt={`${book.title} cover`}
                    className="h-full w-full object-cover"
                />
            ) : (
                <>
                    <div
                        className={`absolute inset-0 ${
                            book.fileType === "pdf"
                                ? "bg-gradient-to-br from-secondary/20 via-surface-container to-error/10"
                                : "bg-gradient-to-br from-primary/15 via-surface-container to-tertiary/10"
                        }`}
                    />
                    <span
                        className={`material-symbols-outlined relative z-10 text-on-surface-variant ${iconClassName}`}
                    >
                        {book.fileType === "pdf" ? "picture_as_pdf" : "menu_book"}
                    </span>
                </>
            )}
        </div>
    );
}
