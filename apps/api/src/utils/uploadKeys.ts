export const createOriginalUploadKey = (userId: string, bookId: string) =>
    `users/${userId}/books/${bookId}/original`;
