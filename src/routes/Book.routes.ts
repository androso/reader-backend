import { Router } from "express";
const router = Router();
import multer from "multer";
import { deleteFile, getFile, uploadFile } from "../utils/storage";
import { authenticate } from "../middleware/auth";
import { db } from "../db";
import { Books } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { queryController } from "../controllers/QueryControllers";
import { processEpub, processPDF } from "../utils/collectionUtils";
import { createHash, extractMetadata } from "../utils/bookUtils";
import { PDFUtils } from "../utils/pdfUtils";
import { file } from "jszip";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 80 * 1024 * 1024, // 80 mb
    },
});
/**
 * @swagger
 * components:
 *   securitySchemes:
 *     bearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique identifier for the user
 *         name:
 *           type: string
 *           description: User's full name
 *         email:
 *           type: string
 *           description: User's email address
 *         googleId:
 *           type: string
 *           description: User's Google ID
 *         createdAt:
 *           type: string
 *           format: date-time
 *         updatedAt:
 *           type: string
 *           format: date-time
 *     Book:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique identifier for the book
 *         title:
 *           type: string
 *           description: Book title
 *         userId:
 *           type: string
 *           description: ID of the user who uploaded the book
 *         fileKey:
 *           type: string
 *           description: Storage key for the book file
 *         createdAt:
 *           type: string
 *           format: date-time
 */

/**
 * @swagger
 * /api/books:
 *   post:
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     summary: Upload and process EPUB file
 *     description: Uploads an EPUB file, creates embeddings, and stores in ChromaDB
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: EPUB file to upload (max 80MB)
 *     responses:
 *       200:
 *         description: File successfully uploaded and processed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "File upload successful"
 *                 book:
 *                   $ref: '#/components/schemas/Book'
 *                 collection:
 *                   type: string
 *                   description: ChromaDB collection name
 *                   example: "book_1ba8cd628f61"
 *       401:
 *         description: Authentication failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "No token provided or invalid token"
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "No file uploaded or invalid file format"
 *       413:
 *         description: Payload too large
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "File size exceeds 80MB limit"
 */
router.post("/", authenticate, upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            res.status(400).json({ error: "No file uploaded" });
            return;
        }
        let fileName;
        const mimeType = req.file.mimetype;
        const fileBuffer = req.file.buffer;
        // Validate file type
        if (!["application/pdf", "application/epub+zip"].includes(mimeType)) {
            res.status(400).json({
                error: "Unsupported file type. Only PDF and EPUB are supported.",
            });
            return;
        }
        if (mimeType === "application/pdf") {
            const pdfUtils = new PDFUtils();
            const hash = await pdfUtils.pdfMetadata(fileBuffer);
            if (!hash) throw new Error("Could not generate hash for PDF");
            fileName = `pdf-${hash.slice(0, 12)}`;
        } else {
            const metadata = await extractMetadata(fileBuffer);
            if (!metadata) throw new Error("Could not extract EPUB metadata");
            fileName = `epub-${createHash(metadata).slice(0, 12)}`;
        }

        await uploadFile(fileName, fileBuffer);

        const [book] = await db
            .insert(Books)
            .values({
                title: req.file.originalname,
                userId: req.user.id,
                fileKey: fileName,
            })
            .returning();

        // Process based on file type
        if (mimeType === "application/pdf") {
            processPDF(fileBuffer, book.id).catch((error) =>
                console.error("Error processing PDF in background", error)
            );
        } else if (mimeType === "application/epub+zip") {
            processEpub(fileBuffer, book.id).catch((error) =>
                console.error("Error processing EPUB in background", error)
            );
        }
        console.log("filename:", fileName);
        res.json({
            message: "File upload successful",
            book,
            processStatus: "started",
            fileType: mimeType,
        });
    } catch (e) {
        console.error("Upload Error", e);
        res.status(500).json({ error: "Upload failed" });
    }
});

/**
 * @swagger
 * tags:
 *   - name: Books
 *     description: Book management endpoints
 *
 * /api/books:
 *   get:
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     summary: Get all books uploaded by user
 *     description: Get all books uploaded by the user
 *     responses:
 *       200:
 *         description: Books successfully fetched
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 books:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         example: "1ba8cd628f61"
 *                       title:
 *                         type: string
 *                         example: "cordwainer-smith_short-fiction.epub"
 *                       userId:
 *                         type: string
 *                         example: "1ba8cd628f61"
 *                       fileKey:
 *                         type: string
 *                         example: "fdd2a6cd-f354-4428-9084-a893a9132318-1736868043356-cordwainer-smith_short-fiction.epub"
 *       401:
 *         description: Authentication failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "No token provided"
 */
router.get("/", authenticate, async (req, res) => {
    const booksList = await db
        .select()
        .from(Books)
        .where(eq(Books.userId, req.user.id));

    res.json({
        books: booksList,
    });
});

/**
 * @swagger
 * tags:
 *   - name: Books
 *     description: Book management endpoints
 *
 * /api/books/{id}:
 *   get:
 *     tags: [Books]
 *     security:
 *       - bearerAuth: []
 *     summary: Get book by id
 *     description: Get book by id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Book ID
 *     responses:
 *       200:
 *         description: Book successfully fetched
 *         content:
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 *       401:
 *         description: Authentication failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "No token provided"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Internal server error"
 */

router.get("/:id", async (req, res) => {
    const id = req.params.id;

    try {
        const fileBuffer = await getFile(id);
        res.type("application/octet-stream");
        res.send(fileBuffer);
    } catch (er) {
        console.error("Error fetching file", er);
        res.status(500).json({ error: "Internal server error" });
    }
});
// working
router.delete("/:id", authenticate, async (req, res) => {
    const bookId = req.params.id;

    try {
        const [book] = await db
            .select()
            .from(Books)
            .where(eq(Books.id, bookId));
        if (!book) {
            res.status(404).json({
                error: "Book was not found",
            });
            return;
        }
        if (book.userId !== req.user.id) {
            res.status(403).json({
                error: "Not authorized",
            });
            return;
        }
        await db.delete(Books).where(eq(Books.id, bookId));

        const [remaining] = await db
            .select({ count: sql`count(*)`.mapWith(Number) })
            .from(Books)
            .where(eq(Books.fileKey, book.fileKey));
        if (remaining.count === 0) {
            // delete file
            await deleteFile(book.fileKey);

            const deleted = await queryController.deleteCollection(
                book.collectionName!
            );
            if (deleted) {
                res.status(204).json({
                    message: "Collection deleted successfully",
                });
            }
        }
    } catch (e) {
        console.error("Error deleting the file", e);
        res.status(500).json({
            error: "Failed to delete the file",
        });
    }
});
export default router;
