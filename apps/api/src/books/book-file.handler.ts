import { Request, Response } from "express";
import { getFile } from "@reader/providers";
import { db } from "../db";
import { Books, type SelectBook } from "../db/schema";
import { eq } from "drizzle-orm";

type BookFileRecord = Pick<
    SelectBook,
    "id" | "userId" | "fileKey" | "fileType"
>;

export type BookFileDependencies = {
    findBookById(bookId: string): Promise<BookFileRecord | undefined>;
    getFile(fileKey: string): Promise<Buffer>;
};

const bookFileDependencies: BookFileDependencies = {
    async findBookById(bookId) {
        const [book] = await db
            .select()
            .from(Books)
            .where(eq(Books.id, bookId));
        return book;
    },
    getFile,
};

const getBookFileContentType = (book: BookFileRecord) => {
    if (book.fileType === "pdf") return "application/pdf";
    if (book.fileType === "epub") return "application/epub+zip";
    return "application/octet-stream";
};

export const handleGetBookFile = async (
    req: Request,
    res: Response,
    dependencies: BookFileDependencies = bookFileDependencies
) => {
    const bookId = req.params.id as string;

    try {
        const book = await dependencies.findBookById(bookId);
        if (!book) {
            res.status(404).json({ error: "Book was not found" });
            return;
        }

        if (book.userId !== req.user.id) {
            res.status(403).json({ error: "Not authorized" });
            return;
        }

        const fileBuffer = await dependencies.getFile(book.fileKey);
        res.setHeader("Cache-Control", "private");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.type(getBookFileContentType(book));
        res.send(fileBuffer);
    } catch (er) {
        console.error("Error fetching file", er);
        res.status(500).json({ error: "Internal server error" });
    }
};
