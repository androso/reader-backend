export interface EpubMetadata {
    title: string | null;
    creator: string | null;
}

export interface ManifestItem {
    href: string;
    mediaType: string;
    properties: string | null;
}

export interface TocEntry {
    title: string;
    level: number;
    id?: string;
    href?: string;
    playOrder?: number;
}

export interface EpubContent {
    metadata: EpubMetadata;
    spine: string[];
    manifest: Record<string, ManifestItem>;
    basePath: string;
    toc: TocEntry[];
}

export interface TextBlock {
    id: string;
    content: string;
    element: HTMLElement;
}

export interface ChapterBlock {
    id: string;
    hrefId: string;
    textBlocks: TextBlock[];
}
