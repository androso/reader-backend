export interface TextChunkerOptions {
    minChunkSize?: number;
    targetChunkSize?: number;
    maxChunkSize?: number;
}

export class TextChunker {
    private readonly minChunkSize: number;
    private readonly targetChunkSize: number;
    private readonly maxChunkSize: number;

    constructor(options: TextChunkerOptions = {}) {
        this.minChunkSize = options.minChunkSize ?? 100;
        this.targetChunkSize = options.targetChunkSize ?? 1000;
        this.maxChunkSize = options.maxChunkSize ?? 3800;
    }

    chunkText(text: string): string[] {
        const normalized = text.replace(/\s+/g, " ").trim();
        if (!normalized) return [];
        if (normalized.length <= this.maxChunkSize) return [normalized];

        const sentences = normalized.match(/[^.!?]+[.!?]+(?:\s+|$)/g) || [
            normalized,
        ];
        const chunks: string[] = [];
        let current = "";

        for (const sentence of sentences) {
            const candidate = `${current} ${sentence}`.trim();
            if (candidate.length <= this.targetChunkSize || !current) {
                current = candidate;
                continue;
            }

            chunks.push(...this.splitOversized(current));
            current = sentence.trim();
        }

        if (current) {
            chunks.push(...this.splitOversized(current));
        }

        const nonEmpty = chunks.filter(Boolean);
        if (
            nonEmpty.length > 1 &&
            nonEmpty[nonEmpty.length - 1].length < this.minChunkSize
        ) {
            const tail = nonEmpty.pop()!;
            nonEmpty[nonEmpty.length - 1] =
                `${nonEmpty[nonEmpty.length - 1]} ${tail}`.trim();
        }
        return nonEmpty;
    }

    private splitOversized(text: string): string[] {
        if (text.length <= this.maxChunkSize) return [text];

        const chunks = [];
        for (let i = 0; i < text.length; i += this.maxChunkSize) {
            chunks.push(text.slice(i, i + this.maxChunkSize).trim());
        }
        return chunks.filter(Boolean);
    }
}
