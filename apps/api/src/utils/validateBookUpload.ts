import JSZip from "jszip";

const MAX_EPUB_ENTRIES = 5_000;
const MAX_EPUB_EXPANDED_BYTES = 500 * 1024 * 1024;
const MAX_EPUB_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 100;

type ZipEntrySizes = {
    compressedSize?: number;
    uncompressedSize?: number;
};

export const validateBookUpload = async (
    buffer: Buffer
): Promise<"pdf" | "epub"> => {
    if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
        throw new Error("File signature is not PDF or EPUB");
    }

    const archive = await JSZip.loadAsync(buffer, { checkCRC32: true });
    const entries = Object.values(archive.files);
    if (entries.length > MAX_EPUB_ENTRIES) {
        throw new Error("EPUB contains too many entries");
    }

    let expandedBytes = 0;
    for (const entry of entries) {
        const unsafeName = entry.unsafeOriginalName ?? entry.name;
        if (
            unsafeName.startsWith("/") ||
            unsafeName.split(/[\\/]/).includes("..")
        ) {
            throw new Error("EPUB contains an unsafe archive path");
        }
        const sizes = (entry as unknown as { _data?: ZipEntrySizes })._data;
        const uncompressed = sizes?.uncompressedSize ?? 0;
        const compressed = sizes?.compressedSize ?? 0;
        expandedBytes += uncompressed;
        if (uncompressed > MAX_EPUB_ENTRY_BYTES) {
            throw new Error("EPUB entry is too large");
        }
        if (compressed > 0 && uncompressed / compressed > MAX_EXPANSION_RATIO) {
            throw new Error("EPUB expansion ratio is too large");
        }
    }
    if (expandedBytes > MAX_EPUB_EXPANDED_BYTES) {
        throw new Error("EPUB expanded size is too large");
    }
    if (!archive.file("META-INF/container.xml")) {
        throw new Error("ZIP archive is not an EPUB");
    }
    return "epub";
};
