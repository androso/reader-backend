export interface ReadingProgress {
    userId: string;
    bookId: string;
    progressPosition: string;
    progressChapter: string | null;
    lastReadAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

export interface SaveReadingProgressInput {
    position: unknown;
    chapter?: unknown;
}

export type ProgressValidationErrorCode =
    | "position_required"
    | "position_invalid"
    | "chapter_invalid";

export class ProgressValidationError extends Error {
    constructor(
        readonly code: ProgressValidationErrorCode,
        message: string
    ) {
        super(message);
        this.name = "ProgressValidationError";
    }
}

export interface ValidatedProgressInput {
    position: string;
    chapter: string | null | undefined;
}

export const validateProgressInput = (
    input: SaveReadingProgressInput
): ValidatedProgressInput => {
    const { position } = input;
    if (position === undefined || position === null || position === "") {
        throw new ProgressValidationError(
            "position_required",
            "Progress Block is required"
        );
    }
    if (typeof position !== "string" || position.trim() === "") {
        throw new ProgressValidationError(
            "position_invalid",
            "Progress Block must be a non-empty string"
        );
    }
    if (
        "chapter" in input &&
        input.chapter !== null &&
        typeof input.chapter !== "string"
    ) {
        throw new ProgressValidationError(
            "chapter_invalid",
            "Progress Chapter must be a string or null"
        );
    }

    return {
        position,
        chapter:
            "chapter" in input ? (input.chapter as string | null) : undefined,
    };
};
