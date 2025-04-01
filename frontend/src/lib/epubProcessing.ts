import JSZip from "jszip";
import {
    type EpubContent,
    type TocEntry,
    type EpubMetadata,
    type ManifestItem,
} from "../types/EpubReader";

const CONTAINER_PATH = "META-INF/container.xml";

export const getBasePath = (opfPath: string): string => {
    const lastSlashIndex = opfPath.lastIndexOf("/");
    return lastSlashIndex !== -1 ? opfPath.slice(0, lastSlashIndex + 1) : "";
};

export const cleanHref = (href: string): string => {
    return href.includes(".") ? href.substring(0, href.lastIndexOf(".")) : href;
};

export const extractId = (src: string): string => {
    return (
        src
            .split("#")[0]
            .split("/")
            .pop()
            ?.replace(/\.x?html?$/, "") || ""
    );
};

const processNavPoint = (navPoint: Element, level: number): TocEntry => {
    const text = navPoint.querySelector("text")?.textContent || "";
    const content = navPoint.querySelector("content");
    const src = content?.getAttribute("src") || "";
    const id = extractId(src);
    const href = cleanHref(src);
    const playOrder = navPoint.getAttribute("playOrder");

    return {
        title: text,
        level,
        id,
        href,
        playOrder: playOrder ? parseInt(playOrder, 10) : undefined,
    };
};

const processEpub3Nav = (navElement: Element): TocEntry[] => {
    const entries: TocEntry[] = [];

    const processListItems = (element: Element, level: number): void => {
        Array.from(element.children).forEach((item) => {
            if (item.tagName.toLowerCase() === "li") {
                const anchor = item.querySelector("a");
                if (anchor) {
                    const href = cleanHref(anchor.getAttribute("href") || "");
                    const id = extractId(href);
                    const text = anchor.textContent?.trim() || "";

                    entries.push({
                        title: text,
                        level,
                        id,
                        href,
                    });
                }

                const nestedList = item.querySelector("ol");
                if (nestedList) {
                    processListItems(nestedList, level + 1);
                }
            }
        });
    };

    const rootList = navElement.querySelector("ol");
    if (rootList) {
        processListItems(rootList, 0);
    }

    return entries;
};

const processEpub2Ncx = (navPoints: HTMLCollectionOf<Element>): TocEntry[] => {
    const entries: TocEntry[] = [];
    const processedHashes = new Set<string>();

    const processNavPoints = (point: Element, level: number) => {
        const id = point.getAttribute("id") || "";
        const playOrder = point.getAttribute("playOrder") || "";
        const hash = `${id}-${playOrder}`;

        if (!processedHashes.has(hash)) {
            processedHashes.add(hash);
            entries.push(processNavPoint(point, level));
        }

        const childNavPoints = point.querySelectorAll(":scope > navPoint");
        childNavPoints.forEach((child) => {
            processNavPoints(child, level + 1);
        });
    };

    Array.from(navPoints).forEach((point) => processNavPoints(point, 0));
    return entries;
};

const processToc = async (
    tocFile: JSZip.JSZipObject,
    manifest: Record<string, ManifestItem>,
    basePath: string,
    zipData: JSZip
): Promise<TocEntry[]> => {
    const tocContent = await tocFile.async("text");
    const tocDoc = new DOMParser().parseFromString(
        tocContent,
        "application/xml"
    );

    const navElement = tocDoc.querySelector('nav[*|type="toc"]');
    if (navElement) {
        return processEpub3Nav(navElement);
    }

    const navPoints = tocDoc.getElementsByTagName("navPoint");
    if (navPoints.length > 0) {
        return processEpub2Ncx(navPoints);
    }

    const ncxItem = manifest["ncx"];
    if (ncxItem) {
        const ncxPath = `${basePath}${ncxItem.href}`;
        const ncxFile = zipData?.file(ncxPath);
        if (ncxFile) {
            const ncxContent = await ncxFile.async("text");
            const ncxDoc = new DOMParser().parseFromString(
                ncxContent,
                "application/xml"
            );
            return processEpub2Ncx(ncxDoc.getElementsByTagName("navPoint"));
        }
    }

    return [];
};

export const processEpubFile = async (
    epubData: ArrayBuffer
): Promise<[EpubContent, JSZip]> => {
    const zip = new JSZip();
    const zipData = await zip.loadAsync(epubData);

    const containerFile = zipData.file(CONTAINER_PATH);
    if (!containerFile) {
        throw new Error("Invalid EPUB: container.xml not found");
    }

    const parser = new DOMParser();
    const containerDoc = parser.parseFromString(
        await containerFile.async("text"),
        "application/xml"
    );

    const rootfile = containerDoc.querySelector("rootfile");
    const opfPath = rootfile?.getAttribute("full-path");
    if (!opfPath) {
        throw new Error("Invalid EPUB: OPF path not found");
    }

    const opfFile = zipData.file(opfPath);
    if (!opfFile) {
        throw new Error("Invalid EPUB: OPF file not found");
    }

    const opfDoc = parser.parseFromString(
        await opfFile.async("text"),
        "application/xml"
    );

    const metadata: EpubMetadata = {
        title: opfDoc.querySelector("dc\\:title, title")?.textContent || null,
        creator:
            opfDoc.querySelector("dc\\:creator, creator")?.textContent || null,
    };

    const manifest: Record<string, ManifestItem> = {};
    opfDoc.querySelectorAll("manifest item").forEach((item) => {
        const id = item.getAttribute("id");
        const href = item.getAttribute("href");
        const mediaType = item.getAttribute("media-type");
        const properties = item.getAttribute("properties");

        if (id && href && mediaType) {
            manifest[id] = { href, mediaType, properties };
        }
    });

    const basePath = getBasePath(opfPath);
    let tocFile = null;

    for (const id in manifest) {
        const item = manifest[id];
        if (item?.properties?.includes("nav")) {
            tocFile = zipData.file(`${basePath}${item.href}`);
            break;
        }
    }

    if (!tocFile) {
        const ncxFile = manifest["ncx"];
        tocFile = zipData.file(`${basePath}${ncxFile?.href}`);
    }

    const spine = Array.from(opfDoc.querySelectorAll("spine itemref"))
        .map((item) => item.getAttribute("idref") || "")
        .filter(Boolean);

    const toc = await processToc(tocFile!, manifest, basePath, zipData);
    console.log({ toc });
    return [
        {
            metadata,
            spine,
            manifest,
            basePath,
            toc,
        },
        zip,
    ];
};
