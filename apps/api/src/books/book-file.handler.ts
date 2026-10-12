import type { Request, Response } from "express";
import { GetOwnedBookFile } from "@reader/application";
import {
    BookAccessDeniedError,
    BookNotFoundError,
    type Book,
} from "@reader/domain";

type BookFileRecord = Pick<Book, "id" | "userId" | "fileKey" | "fileType">;

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
        if (error instanceof BookNotFoundError) {
            res.status(404).json({ error: "Book was not found" });
            return;
        }
        if (error instanceof BookAccessDeniedError) {
            res.status(403).json({ error: "Not authorized" });
            return;
        }
        console.error("Error fetching file", error);
        res.status(500).json({ error: "Internal server error" });
    }
};
