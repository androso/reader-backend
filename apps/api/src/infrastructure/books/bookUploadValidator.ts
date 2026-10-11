import type { BookFileType } from "@reader/domain";
import { validateBookUpload } from "../../utils/validateBookUpload";

export const bookUploadValidator = {
    detectFileType: (buffer: Uint8Array): Promise<BookFileType> =>
        validateBookUpload(Buffer.from(buffer)),
};
