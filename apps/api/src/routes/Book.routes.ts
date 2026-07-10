import { Router } from "express";
const router = Router();
import multer from "multer";
import {
    createLogger,
    deleteFile,
    getFile,
    uploadFile,
    vectorStore,
} from "@reader/providers";
import { authenticate } from "../middleware/auth";
import { db } from "../db";
import { Books } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { createHash, extractMetadata } from "../utils/bookUtils";
import { PDFUtils } from "../utils/pdfUtils";
import { bookSearchChunkStore } from "../services/BookSearchChunkStore";
import { hybridBookSearchService } from "../services/HybridBookSearchService";
import { handleBookProcessingEnqueue } from "../services/BookProcessingEnqueueService";

const log = createLogger("books");

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
    const requestStart = Date.now();
    log.info("Book upload request received", {
        userId: req.user.id,
        fileName: req.file?.originalname,
        mimeType: req.file?.mimetype,
    });
    try {
        if (!req.file) {
            log.warn("Book upload rejected: no file");
            res.status(400).json({ error: "No file uploaded" });
            return;
        }
        let fileName;
        const mimeType = req.file.mimetype;
        const fileBuffer = req.file.buffer;
        // Validate file type
        if (!["application/pdf", "application/epub+zip"].includes(mimeType)) {
            log.warn("Book upload rejected: unsupported file type", {
                mimeType,
                userId: req.user.id,
            });
            res.status(400).json({
                error: "Unsupported file type. Only PDF and EPUB are supported.",
            });
            return;
        }
        if (mimeType === "application/pdf") {
            log.info("Extracting PDF metadata for upload", {
                userId: req.user.id,
                fileName: req.file.originalname,
            });
            const pdfUtils = new PDFUtils();
            const hash = await pdfUtils.pdfMetadata(fileBuffer);
            if (!hash) throw new Error("Could not generate hash for PDF");
            fileName = `pdf-${hash.slice(0, 12)}`;
        } else {
            log.info("Extracting EPUB metadata for upload", {
                userId: req.user.id,
                fileName: req.file.originalname,
            });
            const metadata = await extractMetadata(fileBuffer);
            if (!metadata) throw new Error("Could not extract EPUB metadata");
            fileName = `epub-${createHash(metadata).slice(0, 12)}`;
        }

        log.info("Uploading file to storage", {
            userId: req.user.id,
            fileName,
            mimeType,
        });
        await uploadFile(fileName, fileBuffer);
        log.info("File uploaded to storage", { userId: req.user.id, fileName });
        const fileType = mimeType === "application/pdf" ? "pdf" : "epub";

        const [book] = await db
            .insert(Books)
            .values({
                title: req.file.originalname,
                userId: req.user.id,
                fileKey: fileName,
                fileType,
                processingStatus: "processing",
                processingError: null,
            })
            .returning();
        log.info("Book record created", {
            bookId: book.id,
            userId: req.user.id,
            fileKey: fileName,
            fileType,
        });

        try {
            await handleBookProcessingEnqueue({
                bookId: book.id,
                userId: book.userId,
                fileKey: book.fileKey,
                fileType,
            });
        } catch (error) {
            log.error("Book processing enqueue failed", {
                bookId: book.id,
                error: error instanceof Error ? error.message : String(error),
            });
            res.status(503).json({
                error: "Book processing queue is unavailable",
            });
            return;
        }

        const [queuedBook] = await db
            .select()
            .from(Books)
            .where(eq(Books.id, book.id));

        const duration = Date.now() - requestStart;
        log.info("Book upload accepted", {
            bookId: book.id,
            durationMs: duration,
            fileName,
        });
        res.status(202).json({
            message: "File upload accepted for processing",
            book: queuedBook ?? book,
            processStatus: "processing",
            fileType: mimeType,
        });
    } catch (e) {
        const duration = Date.now() - requestStart;
        log.error("Book upload failed", {
            userId: req.user.id,
            durationMs: duration,
            error: e instanceof Error ? e.message : String(e),
        });
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

router.get("/:id/status", authenticate, async (req, res) => {
    try {
        const [book] = await db
            .select()
            .from(Books)
            .where(eq(Books.id, req.params.id));

        if (!book) {
            res.status(404).json({ error: "Book was not found" });
            return;
        }

        if (book.userId !== req.user.id) {
            res.status(403).json({ error: "Not authorized" });
            return;
        }

        res.json({
            bookId: book.id,
            fileType: book.fileType,
            ready:
                book.processingStatus === "ready" &&
                Boolean(book.collectionName),
            status: book.processingStatus,
            error: book.processingError,
        });
    } catch (error) {
        console.error("Error fetching book processing status", error);
        res.status(500).json({ error: "Internal server error" });
    }
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

router.get("/:id", authenticate, async (req, res) => {
    const id = req.params.id;

    try {
        const fileBuffer = await getFile(id);
        if (id.startsWith("pdf-")) {
            res.type("application/pdf");
        } else if (id.startsWith("epub-")) {
            res.type("application/epub+zip");
        } else {
            res.type("application/octet-stream");
        }
        res.send(fileBuffer);
    } catch (er) {
        console.error("Error fetching file", er);
        res.status(500).json({ error: "Internal server error" });
    }
});
// working
router.delete("/:id", authenticate, async (req, res) => {
    const bookId = req.params.id;
    log.info("Book delete request received", { bookId, userId: req.user.id });

    try {
        const [book] = await db
            .select()
            .from(Books)
            .where(eq(Books.id, bookId));
        if (!book) {
            log.warn("Book delete failed: not found", { bookId });
            res.status(404).json({
                error: "Book was not found",
            });
            return;
        }
        if (book.userId !== req.user.id) {
            log.warn("Book delete failed: unauthorized", {
                bookId,
                userId: req.user.id,
                ownerId: book.userId,
            });
            res.status(403).json({
                error: "Not authorized",
            });
            return;
        }
        await db.delete(Books).where(eq(Books.id, bookId));
        log.info("Book record deleted", { bookId });

        const [remaining] = await db
            .select({ count: sql`count(*)`.mapWith(Number) })
            .from(Books)
            .where(eq(Books.fileKey, book.fileKey));
        if (remaining.count === 0) {
            log.info("Deleting orphaned file and collection", {
                fileKey: book.fileKey,
                collectionName: book.collectionName,
            });
            await deleteFile(book.fileKey);

            if (book.collectionName) {
                await vectorStore.deleteCollection(book.collectionName);
                await bookSearchChunkStore.deleteCollectionChunks(
                    book.collectionName
                );
                hybridBookSearchService.clearCollectionCache(
                    book.collectionName
                );
            }
        } else {
            log.debug("Skipping cleanup, file still referenced", {
                fileKey: book.fileKey,
                remainingCount: remaining.count,
            });
        }

        log.info("Book delete successful", { bookId });
        res.status(204).send();
    } catch (e) {
        log.error("Book delete failed", {
            bookId,
            error: e instanceof Error ? e.message : String(e),
        });
        res.status(500).json({
            error: "Failed to delete the file",
        });
    }
});
export default router;
