import { SelectUser } from "@/db/schema";
import { TextBlock } from "./EpubReader";

export interface Book {
    id: string;
    title: string;
    userId: string;
    fileKey: string;
    createdAt: string | Date;
}

export interface Chapter {
    id: string;
    content: string;
    hrefId: string;
    textBlocks: TextBlock[];
}

export interface BookWithUser extends Book {
    user: SelectUser;
}
