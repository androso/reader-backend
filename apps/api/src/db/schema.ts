import {
    pgTable,
    text,
    timestamp,
    uuid,
    pgEnum,
    integer,
    primaryKey,
    foreignKey,
    uniqueIndex,
    jsonb,
} from "drizzle-orm/pg-core";
import type { BookSearchChunkMetadata } from "@reader/providers";
import type { MessageExecutionMetadata } from "../types/ragTelemetry";

export const messageRoleEnum = pgEnum("message_role", ["user", "assistant"]);
export const resourceTypeEnum = pgEnum("resource_type", ["book", "article"]);
export const fileTypeEnum = pgEnum("file_type", ["epub", "pdf"]);
export const messageCompletionStatusEnum = pgEnum("message_completion_status", [
    "complete",
    "truncated",
    "cancelled",
    "failed",
]);

export const Users = pgTable("users", {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").unique().notNull(),
    name: text("name").notNull(),
    image: text("image"),
    googleId: text("google_id").unique(),
    password: text("password"), // For future email+password auth
    username: text("username").unique(), // For future username support
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// here, we call books the .epub and .pdf files
export const Books = pgTable("books", {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title").notNull(),
    userId: uuid("user_id")
        .references(() => Users.id)
        .notNull(),
    fileKey: text("file_key").notNull(),
    fileType: fileTypeEnum("file_type"),
    collectionName: text("collection_name"),
    processingStatus: text("processing_status").default("processing").notNull(),
    processingError: text("processing_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const BookSearchChunks = pgTable(
    "book_search_chunks",
    {
        id: text("id").primaryKey(),
        collectionName: text("collection_name").notNull(),
        chunkIndex: integer("chunk_index").notNull(),
        content: text("content").notNull(),
        metadata: jsonb("metadata").$type<BookSearchChunkMetadata | null>(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
        uniqueIndex("book_search_chunks_collection_chunk_idx").on(
            table.collectionName,
            table.chunkIndex
        ),
    ]
);

export const Conversations = pgTable("conversations", {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
        .references(() => Users.id)
        .notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
    resourceType: resourceTypeEnum("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
});

export type MessageContextSource = {
    id: string;
    chunkIndex: number;
    score: number;
    bestRank: number;
    excerpt: string;
    metadata?: BookSearchChunkMetadata | null;
};

export const Messages = pgTable("messages", {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
        .references(() => Conversations.id, { onDelete: "cascade" })
        .notNull(),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    contextSources: jsonb("context_sources").$type<
        MessageContextSource[] | null
    >(),
    completionStatus: messageCompletionStatusEnum("completion_status"),
    finishReason: text("finish_reason"),
    executionMetadata:
        jsonb("execution_metadata").$type<MessageExecutionMetadata | null>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const Progress = pgTable(
    "progress",
    {
        userId: uuid("user_id").notNull(),
        bookId: uuid("book_id").notNull(),
        progressPosition: text("progress_position").notNull(),
        progressChapter: text("progress_chapter").notNull(),
        lastReadAt: timestamp("last_read_at", { withTimezone: true })
            .defaultNow()
            .notNull(),
        createdAt: timestamp("created_at", { withTimezone: true })
            .defaultNow()
            .notNull(),
        updatedAt: timestamp("updated_at", { withTimezone: true })
            .defaultNow()
            .notNull(),
    },
    (table) => [
        primaryKey({
            columns: [table.userId, table.bookId],
            name: "progress_user_id_book_id_pk",
        }),
        foreignKey({
            columns: [table.bookId],
            foreignColumns: [Books.id],
            name: "progress_book_id_books_id_fk",
        }).onDelete("cascade"),
        foreignKey({
            columns: [table.userId],
            foreignColumns: [Users.id],
            name: "progress_user_id_users_id_fk",
        }).onDelete("cascade"),
    ]
);

export type InsertUser = typeof Users.$inferInsert;
export type SelectUser = typeof Users.$inferSelect;
export type InsertBook = typeof Books.$inferInsert;
export type SelectBook = typeof Books.$inferSelect;
