export interface Account {
    id: string;
    email: string;
    name: string;
    image: string | null;
    googleId: string | null;
    password: string | null;
    username: string | null;
    createdAt: Date;
    updatedAt: Date;
}
