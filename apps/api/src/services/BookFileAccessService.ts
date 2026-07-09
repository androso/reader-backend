import { and, eq } from "drizzle-orm";
import { getFile } from "@reader/providers";
import { db } from "../db";
import { Books } from "../db/schema";

type BookFileType = "epub" | "pdf" | null;

export interface BookFileRecord {
    id: string;
    userId: string;
    fileKey: string;
    fileType: BookFileType;
}

export interface BookFileRepository {
    findOwnedBook(
        bookId: string,
        userId: string
    ): Promise<BookFileRecord | null>;
}

export interface BookFileStorage {
    getFile(fileKey: string): Promise<Buffer>;
}

export interface BookFileAccessDependencies {
    repository: BookFileRepository;
    storage: BookFileStorage;
}

export type BookFileAccessResult =
    | {
          status: "found";
          fileBuffer: Buffer;
          contentType: string;
          book: BookFileRecord;
      }
    | {
          status: "not_found";
      };

export const getBookContentType = (fileType: BookFileType) => {
    if (fileType === "pdf") return "application/pdf";
    if (fileType === "epub") return "application/epub+zip";
    return "application/octet-stream";
};

export const createDbBookFileRepository = (): BookFileRepository => ({
    async findOwnedBook(bookId, userId) {
        const [book] = await db
            .select({
                id: Books.id,
                userId: Books.userId,
                fileKey: Books.fileKey,
                fileType: Books.fileType,
            })
            .from(Books)
            .where(and(eq(Books.id, bookId), eq(Books.userId, userId)));

        return book ?? null;
    },
});

export const createObjectBookFileStorage = (): BookFileStorage => ({
    getFile,
});

export const getOwnedBookFile = async (
    bookId: string,
    userId: string,
    dependencies: BookFileAccessDependencies
): Promise<BookFileAccessResult> => {
    const book = await dependencies.repository.findOwnedBook(bookId, userId);
    if (!book) return { status: "not_found" };

    const fileBuffer = await dependencies.storage.getFile(book.fileKey);

    return {
        status: "found",
        fileBuffer,
        contentType: getBookContentType(book.fileType),
        book,
    };
};
