import { SelectUser } from "@/db/schema";

export interface Book {
    id: string;
    title: string;
    userId: string;
    fileKey: string;
    createdAt: Date;
}

export interface BookWithUser extends Book {
    user: SelectUser;
}
