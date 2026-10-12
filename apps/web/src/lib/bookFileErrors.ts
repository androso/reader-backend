export const getBookFileErrorMessage = async (response: Response) => {
    if (response.status === 404) {
        try {
            const body: unknown = await response.json();
            if (
                typeof body === "object" &&
                body !== null &&
                "code" in body &&
                body.code === "BOOK_FILE_MISSING"
            ) {
                return "The original book file is missing from storage. Restore it from a backup or upload the book again.";
            }
        } catch {}
        return "This book is no longer available. Return to your library and upload it again if needed.";
    }
    if (response.status === 401)
        return "Please sign in again to read this book.";
    if (response.status === 403)
        return "You do not have permission to read this book.";
    return `Could not load the book (${response.status}). Please try again later.`;
};
