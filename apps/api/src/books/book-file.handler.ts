import type { Request, Response } from "express";
import { GetOwnedBookFile } from "@reader/application";
import {
    BookAccessDeniedError,
    BookFileUnavailableError,
    BookNotFoundError,
    type Book,
} from "@reader/domain";

type BookFileRecord = Pick<Book, "id" | "userId" | "fileKey" | "fileType"> &
    Partial<Pick<Book, "processingStatus">>;

export const getBookFileErrorResponse = (error: unknown) => {
    if (error instanceof BookNotFoundError) {
        return { status: 404, body: { error: "Book was not found" } };
    }
    if (error instanceof BookAccessDeniedError) {
        return { status: 403, body: { error: "Not authorized" } };
    }
    if (error instanceof BookFileUnavailableError) {
        return {
            status: 404,
            body: {
                error: "Book file is missing from storage. Restore the original file or upload the book again.",
                code: "BOOK_FILE_MISSING",
            },
        };
    }
    return null;
};

export type BookFileDependencies = {
    findBookById(bookId: string): Promise<BookFileRecord | undefined>;
    getFile(fileKey: string): Promise<Buffer>;
};

const getBookFileContentType = (fileType: Book["fileType"]) => {
    if (fileType === "pdf") return "application/pdf";
    if (fileType === "epub") return "application/epub+zip";
    return "application/octet-stream";
};

export const handleGetBookFile = async (
    req: Request,
    res: Response,
    dependencies: BookFileDependencies
) => {
    const bookId = req.params.id as string;
    const getOwnedBookFile = new GetOwnedBookFile({
        books: {
            findById: async (id) =>
                (await dependencies.findBookById(id)) ?? null,
        },
        storage: { getFile: dependencies.getFile },
    });

    try {
        const file = await getOwnedBookFile.execute({
            bookId,
            userId: req.user.id,
        });
        res.setHeader("Cache-Control", "private");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.type(getBookFileContentType(file.fileType));
        res.send(file.bytes);
    } catch (error) {
        const response = getBookFileErrorResponse(error);
        if (response) {
            res.status(response.status).json(response.body);
            return;
        }
        console.error("Error fetching file", error);
        res.status(500).json({ error: "Internal server error" });
    }
};
