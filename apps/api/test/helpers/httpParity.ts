import { createHmac, timingSafeEqual } from "node:crypto";

export const REFERENCE_COMMIT = "56ae8954";
export const FRONTEND_URL = "http://localhost:5173";
export const LOCAL_ORIGIN = "http://127.0.0.1:5173";
export const UNTRUSTED_ORIGIN = "https://untrusted.example";
export const JWT_SECRET = "reader-api-test-secret";
export const PROD_AUTH_COOKIE = "__Host-reader_session";
export const DEV_AUTH_COOKIE = "reader_session";
export const AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const GOOGLE_ID_TOKEN_VALID = "valid-google";
export const GOOGLE_ID_TOKEN_INVALID = "invalid-google";

export interface OwnerUser {
    id: string;
    email: string;
    name: string;
    image: string | null;
    googleId: string;
    username: string;
    password: string | null;
    createdAt: string;
    updatedAt: string;
}

export const OWNER: OwnerUser = {
    id: "owner-1",
    email: "owner@example.com",
    name: "Owner",
    image: null,
    googleId: "google-owner",
    username: "owner",
    password: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
};

export const OWNER_ROW: Record<string, unknown> = {
    id: "owner-1",
    email: "owner@example.com",
    name: "Owner",
    image: null,
    google_id: "google-owner",
    password: null,
    username: "owner",
    created_at: "2024-01-01 00:00:00",
    updated_at: "2024-01-01 00:00:00",
};

export const BOOK_ROW: Record<string, unknown> = {
    id: "book-1",
    title: "Example.pdf",
    user_id: "owner-1",
    file_key: "file-1",
    file_type: "pdf",
    collection_name: "collection-1",
    processing_status: "ready",
    processing_error: null,
    created_at: "2024-01-01 00:00:00",
};

export const OTHER_OWNER_BOOK_ROW: Record<string, unknown> = {
    ...BOOK_ROW,
    user_id: "other-user-1",
};

export const EPUB_BOOK_ROW: Record<string, unknown> = {
    ...BOOK_ROW,
    file_type: "epub",
};

export const NULL_FILE_TYPE_BOOK_ROW: Record<string, unknown> = {
    ...BOOK_ROW,
    file_type: null,
};

export const BOOK_ID_REF_ROW: Record<string, unknown> = {
    id: "book-1",
    user_id: "owner-1",
};

export const OTHER_BOOK_ID_REF_ROW: Record<string, unknown> = {
    id: "book-1",
    user_id: "other-user-1",
};

export const PROGRESS_ROW: Record<string, unknown> = {
    user_id: "owner-1",
    book_id: "book-1",
    progress_position: "p1",
    progress_chapter: "c1",
    last_read_at: "2024-01-01 00:00:00+00",
    created_at: "2024-01-01 00:00:00+00",
    updated_at: "2024-01-01 00:00:00+00",
};

export const PROGRESS_ROW_NO_CHAPTER: Record<string, unknown> = {
    ...PROGRESS_ROW,
    progress_chapter: null,
};

export const GOOGLE_PAYLOAD_OWNER = {
    sub: "google-owner",
    email: "owner@example.com",
    name: "Owner",
};

export type RecordedEffect = Record<string, unknown> & { type: string };

export interface EffectRecorder {
    effects: RecordedEffect[];
    record(effect: RecordedEffect): void;
}

export const createEffectRecorder = (): EffectRecorder => ({
    effects: [],
    record(effect) {
        this.effects.push(effect);
    },
});

export type DbOperation = "select" | "insert" | "update" | "delete" | "other";

export interface DbStep {
    op: DbOperation;

    table?: string;

    rows?: Record<string, unknown>[];

    error?: string;
}

export class UnexpectedDbQueryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UnexpectedDbQueryError";
    }
}

const extractQueryText = (queryConfig: unknown): string => {
    if (typeof queryConfig === "string") return queryConfig;
    if (
        queryConfig &&
        typeof queryConfig === "object" &&
        typeof (queryConfig as { text?: unknown }).text === "string"
    ) {
        return (queryConfig as { text: string }).text;
    }
    throw new UnexpectedDbQueryError(
        `Unrecognized query config: ${JSON.stringify(queryConfig)}`
    );
};

export const classifyDbQuery = (
    text: string
): { op: DbOperation; table?: string } => {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("select")) {
        const match = /from\s+"([^"]+)"/i.exec(trimmed);
        return { op: "select", table: match?.[1] };
    }
    if (lower.startsWith("insert")) {
        const match = /insert\s+into\s+"([^"]+)"/i.exec(trimmed);
        return { op: "insert", table: match?.[1] };
    }
    if (lower.startsWith("update")) {
        const match = /update\s+"([^"]+)"/i.exec(trimmed);
        return { op: "update", table: match?.[1] };
    }
    if (lower.startsWith("delete")) {
        const match = /delete\s+from\s+"([^"]+)"/i.exec(trimmed);
        return { op: "delete", table: match?.[1] };
    }
    return { op: "other" };
};

const serializeParamValue = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString();
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
        return { __base64: value.toString("base64") };
    }
    if (Array.isArray(value)) return value.map(serializeParamValue);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(
            value as Record<string, unknown>
        )) {
            out[key] = serializeParamValue(child);
        }
        return out;
    }
    return value === undefined ? null : value;
};

export const serializeParams = (params: unknown): unknown[] => {
    const list = Array.isArray(params) ? params : [];
    return list.map(serializeParamValue);
};

const splitTopLevelList = (list: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let inQuote = false;
    let start = 0;
    for (let i = 0; i < list.length; i++) {
        const ch = list[i];
        if (ch === '"') inQuote = !inQuote;
        else if (!inQuote && ch === "(") depth++;
        else if (!inQuote && ch === ")") depth--;
        else if (!inQuote && depth === 0 && ch === ",") {
            parts.push(list.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(list.slice(start));
    return parts.map((part) => part.trim()).filter(Boolean);
};

const columnNameFromSelectItem = (item: string): string | null => {
    const asMatch = /\s+as\s+"([^"]+)"\s*$/i.exec(item);
    const source = asMatch ? item.slice(0, asMatch.index) : item;
    const quoted = [...source.matchAll(/"([^"]+)"/g)];
    if (quoted.length) return quoted[quoted.length - 1][1];
    const bare = /^[a-zA-Z_][\w$]*/.exec(source.trim());
    return bare ? bare[0] : null;
};

export const extractResultColumns = (sql: string): string[] => {
    const trimmed = sql.trim();
    const selectMatch = /^select\s+(.+?)\s+from\s+/is.exec(trimmed);
    const returningMatch = /\s+returning\s+(.+?)\s*;?$/is.exec(trimmed);
    const list = selectMatch?.[1] ?? returningMatch?.[1];
    if (!list) return [];
    return splitTopLevelList(list)
        .map(columnNameFromSelectItem)
        .filter((name): name is string => name !== null);
};

export const projectRowToDriverArray = (
    row: Record<string, unknown>,
    columns: string[]
): unknown[] =>
    columns.map((name) =>
        Object.prototype.hasOwnProperty.call(row, name) ? row[name] : null
    );

export interface ScriptedDbQueryHandler {
    (
        queryConfig: unknown,
        params?: unknown[]
    ): Promise<{
        rows: Record<string, unknown>[];
    }>;

    remainingSteps(): number;
}

export const createScriptedDbQueryHandler = (
    steps: DbStep[],
    record: (effect: RecordedEffect) => void
): ScriptedDbQueryHandler => {
    const queue = [...steps];
    const handler = async (
        queryConfig: unknown,
        params?: unknown[]
    ): Promise<{ rows: Record<string, unknown>[] }> => {
        const text = extractQueryText(queryConfig);
        if (/^(begin|commit|rollback)\b/i.test(text.trim())) {
            return { rows: [] };
        }
        const { op, table } = classifyDbQuery(text);
        const action: RecordedEffect = {
            type: "db",
            operation: op,
            ...(table ? { table } : {}),
            sql: text,
            params: serializeParams(params),
        };

        const step = queue.shift();
        if (!step) {
            record({ ...action, unexpected: true });
            throw new UnexpectedDbQueryError(
                `Unscripted db query: ${text} params=${JSON.stringify(
                    serializeParams(params)
                )}`
            );
        }
        if (step.op !== op || (step.table && step.table !== table)) {
            record({
                ...action,
                unexpected: true,
                expected: { op: step.op, table: step.table },
            });
            throw new UnexpectedDbQueryError(
                `Scripted db mismatch: expected ${step.op} ${
                    step.table ?? "*"
                }, got ${op} ${table ?? "*"} :: ${text}`
            );
        }

        if (step.error) {
            record({ ...action, error: step.error });
            throw new Error(step.error);
        }

        record(action);
        return { rows: step.rows ?? [] };
    };
    handler.remainingSteps = () => queue.length;
    return handler;
};

export type ScenarioEnv = "test" | "production";

export type CookieSpec =
    | "valid"
    | "validProd"
    | "expired"
    | "expiredProd"
    | "tampered"
    | "tamperedProd";

export type OriginSpec = "trusted" | "untrusted" | "local" | "none";

export type ScenarioBody =
    | { kind: "json"; value: unknown }
    | { kind: "raw"; text: string; contentType: string }
    | {
          kind: "padded";
          contentType: string;
          prefix: string;
          suffix: string;
          padChar: string;
          length: number;
      }
    | { kind: "urlencoded"; fields: Record<string, string> }
    | {
          kind: "multipart";
          parts: MultipartPart[];

          truncateAt?: number;
      };

export interface MultipartPart {
    name: string;
    filename?: string;
    contentType?: string;
    text?: string;
    base64?: string;
}

export interface StubScript {
    google?: Record<string, unknown> | "reject";

    getFile?: { base64: string } | { error: string };
    uploadFile?: { error?: string };
    deleteFile?: { error?: string };
    enqueueBookProcessing?: { error?: string };
    enqueueRagShadow?: { error?: string };
}

export interface HttpParityScenario {
    id: string;
    env: ScenarioEnv;

    intentionalDifference?: string;
    request: {
        method: string;
        path: string;

        origin?: OriginSpec;
        headers?: Record<string, string>;
        cookies?: CookieSpec[];
        body?: ScenarioBody;

        ifNoneMatchFrom?: string;
    };
    db: DbStep[];
    stubs?: StubScript;
}

const authUser: DbStep = { op: "select", table: "users", rows: [OWNER_ROW] };
const bookById = (row: Record<string, unknown>): DbStep => ({
    op: "select",
    table: "books",
    rows: [row],
});
const emptyBookSelect: DbStep = { op: "select", table: "books", rows: [] };
const insertProgress = (row: Record<string, unknown>): DbStep => ({
    op: "insert",
    table: "progress",
    rows: [row],
});
const progressSelect = (rows: Record<string, unknown>[]): DbStep => ({
    op: "select",
    table: "progress",
    rows,
});
const bookRefSelect = (row: Record<string, unknown>): DbStep => ({
    op: "select",
    table: "books",
    rows: [row],
});

const PDF_FILE_BASE64 = Buffer.from("%PDF-synthetic\n", "utf8").toString(
    "base64"
);
const OVERSIZE_LENGTH = 110_000;

export const SCENARIOS: HttpParityScenario[] = [
    {
        id: "root-get",
        env: "test",
        request: { method: "GET", path: "/" },
        db: [],
    },
    {
        id: "health-get",
        env: "test",
        request: { method: "GET", path: "/health" },
        db: [],
    },
    {
        id: "unknown-get",
        env: "test",
        intentionalDifference: "unknown-route-json",
        request: { method: "GET", path: "/does-not-exist" },
        db: [],
    },
    {
        id: "unknown-post",
        env: "test",
        intentionalDifference: "unknown-route-json",
        request: {
            method: "POST",
            path: "/does-not-exist",
            body: { kind: "json", value: {} },
        },
        db: [],
    },
    {
        id: "api-progress-get",
        env: "test",
        intentionalDifference: "unknown-route-json",
        request: { method: "GET", path: "/api/progress" },
        db: [],
    },

    {
        id: "cors-health-allowed-origin",
        env: "test",
        request: {
            method: "GET",
            path: "/health",
            origin: "trusted",
        },
        db: [],
    },
    {
        id: "cors-health-disallowed-origin",
        env: "test",
        request: {
            method: "GET",
            path: "/health",
            origin: "untrusted",
        },
        db: [],
    },
    {
        id: "cors-preflight-books",
        env: "test",
        request: {
            method: "OPTIONS",
            path: "/api/books",
            origin: "trusted",
            headers: {
                "access-control-request-method": "POST",
                "access-control-request-headers": "content-type",
            },
        },
        db: [],
    },
    {
        id: "csrf-logout-missing-origin",
        env: "test",
        request: { method: "POST", path: "/api/auth/logout", origin: "none" },
        db: [],
    },
    {
        id: "csrf-logout-local-origin",
        env: "test",
        request: { method: "POST", path: "/api/auth/logout", origin: "local" },
        db: [],
    },
    {
        id: "cors-logout-disallowed-origin",
        env: "test",
        request: {
            method: "POST",
            path: "/api/auth/logout",
            origin: "untrusted",
        },
        db: [],
    },
    {
        id: "auth-logout-trusted",
        env: "test",
        request: {
            method: "POST",
            path: "/api/auth/logout",
            origin: "trusted",
        },
        db: [],
    },
    {
        id: "auth-logout-prod",
        env: "production",
        request: {
            method: "POST",
            path: "/api/auth/logout",
            origin: "trusted",
        },
        db: [],
    },

    {
        id: "user-get-no-cookie",
        env: "test",
        request: { method: "GET", path: "/api/user" },
        db: [],
    },
    {
        id: "user-get-expired-cookie",
        env: "test",
        request: {
            method: "GET",
            path: "/api/user",
            cookies: ["expired"],
        },
        db: [],
    },
    {
        id: "user-get-tampered-cookie",
        env: "test",
        request: {
            method: "GET",
            path: "/api/user",
            cookies: ["tampered"],
        },
        db: [],
    },
    {
        id: "user-get-valid-cookie",
        env: "test",
        request: {
            method: "GET",
            path: "/api/user",
            cookies: ["valid"],
        },
        db: [authUser],
    },
    {
        id: "user-get-prod-cookie-priority",
        env: "test",
        request: {
            method: "GET",
            path: "/api/user",
            cookies: ["validProd", "tampered"],
        },
        db: [authUser],
    },
    {
        id: "user-get-prod-tampered-priority",
        env: "test",
        request: {
            method: "GET",
            path: "/api/user",
            cookies: ["tamperedProd", "valid"],
        },
        db: [],
    },
    {
        id: "auth-google-existing-user",
        env: "test",
        request: {
            method: "POST",
            path: "/api/auth/google",
            body: { kind: "json", value: { idToken: GOOGLE_ID_TOKEN_VALID } },
        },
        stubs: { google: GOOGLE_PAYLOAD_OWNER },
        db: [
            { op: "select", table: "users", rows: [OWNER_ROW] },
            { op: "update", table: "users", rows: [OWNER_ROW] },
        ],
    },
    {
        id: "auth-google-new-user",
        env: "test",
        request: {
            method: "POST",
            path: "/api/auth/google",
            body: { kind: "json", value: { idToken: GOOGLE_ID_TOKEN_VALID } },
        },
        stubs: { google: GOOGLE_PAYLOAD_OWNER },
        db: [
            { op: "select", table: "users", rows: [] },
            { op: "insert", table: "users", rows: [OWNER_ROW] },
        ],
    },
    {
        id: "auth-google-invalid-token",
        env: "test",
        request: {
            method: "POST",
            path: "/api/auth/google",
            body: { kind: "json", value: { idToken: GOOGLE_ID_TOKEN_INVALID } },
        },
        stubs: { google: "reject" },
        db: [],
    },
    {
        id: "auth-dev-existing-user",
        env: "test",
        request: { method: "POST", path: "/api/auth/dev", origin: "trusted" },
        db: [{ op: "select", table: "users", rows: [OWNER_ROW] }],
    },
    {
        id: "auth-dev-prod",
        env: "production",
        request: { method: "POST", path: "/api/auth/dev", origin: "trusted" },
        db: [],
    },

    {
        id: "progress-post-no-body",
        env: "test",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
        },
        db: [authUser],
    },
    {
        id: "progress-post-empty-json-body",
        env: "test",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
            body: { kind: "raw", text: "", contentType: "application/json" },
        },
        db: [authUser],
    },
    {
        id: "progress-post-text-plain",
        env: "test",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
            body: { kind: "raw", text: "{}", contentType: "text/plain" },
        },
        db: [authUser],
    },
    {
        id: "progress-post-empty-object",
        env: "test",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
            body: { kind: "json", value: {} },
        },
        db: [authUser],
    },
    {
        id: "progress-post-empty-block",
        env: "test",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
            body: { kind: "json", value: { progress_block: "" } },
        },
        db: [authUser],
    },
    {
        id: "progress-post-urlencoded-empty",
        env: "test",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
            body: { kind: "urlencoded", fields: {} },
        },
        db: [authUser],
    },

    {
        id: "auth-google-no-body",
        env: "test",
        request: { method: "POST", path: "/api/auth/google" },
        db: [],
    },
    {
        id: "auth-google-empty-json-body",
        env: "test",
        request: {
            method: "POST",
            path: "/api/auth/google",
            body: { kind: "raw", text: "", contentType: "application/json" },
        },
        db: [],
    },
    {
        id: "auth-google-empty-object",
        env: "test",
        request: {
            method: "POST",
            path: "/api/auth/google",
            body: { kind: "json", value: {} },
        },
        db: [],
    },
    {
        id: "auth-google-text-plain",
        env: "test",
        request: {
            method: "POST",
            path: "/api/auth/google",
            body: { kind: "raw", text: "{}", contentType: "text/plain" },
        },
        db: [],
    },
    {
        id: "auth-google-urlencoded-empty",
        env: "test",
        request: {
            method: "POST",
            path: "/api/auth/google",
            body: { kind: "urlencoded", fields: {} },
        },
        db: [],
    },

    {
        id: "progress-post-malformed-json",
        env: "production",
        intentionalDifference: "parser-error-status",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
            body: { kind: "raw", text: "{", contentType: "application/json" },
        },
        db: [],
    },
    {
        id: "progress-post-malformed-json-no-origin",
        env: "production",
        intentionalDifference: "parser-error-status",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            origin: "none",
            cookies: ["valid"],
            body: { kind: "raw", text: "{", contentType: "application/json" },
        },
        db: [],
    },
    {
        id: "progress-post-oversized-json",
        env: "production",
        intentionalDifference: "parser-error-status",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
            body: {
                kind: "padded",
                contentType: "application/json",
                prefix: '{"progress_block":"',
                suffix: '"}',
                padChar: "x",
                length: OVERSIZE_LENGTH,
            },
        },
        db: [],
    },
    {
        id: "progress-post-oversized-urlencoded",
        env: "production",
        intentionalDifference: "parser-error-status",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
            body: {
                kind: "padded",
                contentType: "application/x-www-form-urlencoded",
                prefix: "progress_block=",
                suffix: "",
                padChar: "x",
                length: OVERSIZE_LENGTH,
            },
        },
        db: [],
    },
];

export const SUPPLEMENTAL_SCENARIOS: HttpParityScenario[] = [
    {
        id: "progress-post-urlencoded",
        env: "test",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
            body: {
                kind: "urlencoded",
                fields: { progress_block: "p1", progress_chapter: "c1" },
            },
        },
        db: [authUser, bookById(BOOK_ROW), insertProgress(PROGRESS_ROW)],
    },
    {
        id: "progress-post-extra-field",
        env: "test",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
            body: {
                kind: "json",
                value: { progress_block: "p1", extra: "ignored" },
            },
        },
        db: [
            authUser,
            bookById(BOOK_ROW),
            insertProgress(PROGRESS_ROW_NO_CHAPTER),
        ],
    },
    {
        id: "progress-post-json-insert",
        env: "test",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
            body: {
                kind: "json",
                value: { progress_block: "p1", progress_chapter: "c1" },
            },
        },
        db: [authUser, bookById(BOOK_ROW), insertProgress(PROGRESS_ROW)],
    },
    {
        id: "progress-post-json-update",
        env: "test",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
            body: {
                kind: "json",
                value: { progress_block: "p1", progress_chapter: "c1" },
            },
        },
        db: [authUser, bookById(BOOK_ROW), insertProgress(PROGRESS_ROW)],
    },
    {
        id: "progress-post-urlencoded-no-chapter",
        env: "test",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
            body: {
                kind: "urlencoded",
                fields: { progress_block: "p1" },
            },
        },
        db: [
            authUser,
            bookById(BOOK_ROW),
            insertProgress(PROGRESS_ROW_NO_CHAPTER),
        ],
    },

    {
        id: "books-post-unauthenticated",
        env: "test",
        request: {
            method: "POST",
            path: "/api/books",
            body: {
                kind: "multipart",
                parts: [
                    {
                        name: "file",
                        filename: "Example.pdf",
                        contentType: "application/pdf",
                        text: "%PDF-synthetic\n",
                    },
                ],
            },
        },
        db: [],
    },
    {
        id: "books-post-no-file",
        env: "test",
        request: {
            method: "POST",
            path: "/api/books",
            cookies: ["valid"],
            body: {
                kind: "multipart",
                parts: [{ name: "title", text: "no file here" }],
            },
        },
        db: [authUser],
    },
    {
        id: "books-post-invalid-file",
        env: "test",
        request: {
            method: "POST",
            path: "/api/books",
            cookies: ["valid"],
            body: {
                kind: "multipart",
                parts: [
                    {
                        name: "file",
                        filename: "notabook.bin",
                        contentType: "application/octet-stream",
                        text: "this is not a pdf or epub",
                    },
                ],
            },
        },
        db: [authUser],
    },
    {
        id: "books-post-unexpected-field",
        env: "production",
        intentionalDifference: "multipart-error-status",
        request: {
            method: "POST",
            path: "/api/books",
            cookies: ["valid"],
            body: {
                kind: "multipart",
                parts: [
                    {
                        name: "notfile",
                        filename: "Example.pdf",
                        contentType: "application/pdf",
                        text: "%PDF-synthetic\n",
                    },
                ],
            },
        },
        db: [authUser],
    },
    {
        id: "books-post-truncated-multipart",
        env: "production",
        intentionalDifference: "multipart-error-status",
        request: {
            method: "POST",
            path: "/api/books",
            cookies: ["valid"],
            body: {
                kind: "multipart",
                truncateAt: 170,
                parts: [
                    {
                        name: "file",
                        filename: "Example.pdf",
                        contentType: "application/pdf",
                        text: "%PDF-synthetic\n",
                    },
                ],
            },
        },
        db: [authUser],
    },
    {
        id: "books-list",
        env: "test",
        request: {
            method: "GET",
            path: "/api/books",
            cookies: ["valid"],
        },
        db: [authUser, { op: "select", table: "books", rows: [BOOK_ROW] }],
    },
    {
        id: "books-status-ready",
        env: "test",
        request: {
            method: "GET",
            path: "/api/books/book-1/status",
            cookies: ["valid"],
        },
        db: [authUser, bookById(BOOK_ROW)],
    },
    {
        id: "books-status-missing",
        env: "test",
        request: {
            method: "GET",
            path: "/api/books/missing-book/status",
            cookies: ["valid"],
        },
        db: [authUser, emptyBookSelect],
    },
    {
        id: "books-status-nonowner",
        env: "test",
        request: {
            method: "GET",
            path: "/api/books/book-1/status",
            cookies: ["valid"],
        },
        db: [authUser, bookById(OTHER_OWNER_BOOK_ROW)],
    },
    {
        id: "books-retry-ready",
        env: "test",
        request: {
            method: "POST",
            path: "/api/books/book-1/retry",
            cookies: ["valid"],
        },
        db: [authUser, bookById(BOOK_ROW)],
    },
    {
        id: "books-retry-missing",
        env: "test",
        request: {
            method: "POST",
            path: "/api/books/missing-book/retry",
            cookies: ["valid"],
        },
        db: [authUser, emptyBookSelect],
    },
    {
        id: "books-retry-nonowner",
        env: "test",
        request: {
            method: "POST",
            path: "/api/books/book-1/retry",
            cookies: ["valid"],
        },
        db: [authUser, bookById(OTHER_OWNER_BOOK_ROW)],
    },
    {
        id: "books-file-pdf",
        env: "test",
        request: {
            method: "GET",
            path: "/api/books/book-1",
            cookies: ["valid"],
        },
        stubs: { getFile: { base64: PDF_FILE_BASE64 } },
        db: [authUser, bookById(BOOK_ROW)],
    },
    {
        id: "books-file-epub",
        env: "test",
        request: {
            method: "GET",
            path: "/api/books/book-1",
            cookies: ["valid"],
        },
        stubs: { getFile: { base64: PDF_FILE_BASE64 } },
        db: [authUser, bookById(EPUB_BOOK_ROW)],
    },
    {
        id: "books-file-null-type",
        env: "test",
        request: {
            method: "GET",
            path: "/api/books/book-1",
            cookies: ["valid"],
        },
        stubs: { getFile: { base64: PDF_FILE_BASE64 } },
        db: [authUser, bookById(NULL_FILE_TYPE_BOOK_ROW)],
    },
    {
        id: "books-file-missing",
        env: "test",
        request: {
            method: "GET",
            path: "/api/books/missing-book",
            cookies: ["valid"],
        },
        db: [authUser, emptyBookSelect],
    },
    {
        id: "books-file-nonowner",
        env: "test",
        request: {
            method: "GET",
            path: "/api/books/book-1",
            cookies: ["valid"],
        },
        db: [authUser, bookById(OTHER_OWNER_BOOK_ROW)],
    },
    {
        id: "books-file-storage-error",
        env: "production",
        request: {
            method: "GET",
            path: "/api/books/book-1",
            cookies: ["valid"],
        },
        stubs: { getFile: { error: "storage backend unavailable" } },
        db: [authUser, bookById(BOOK_ROW)],
    },
    {
        id: "books-file-head",
        env: "test",
        request: {
            method: "HEAD",
            path: "/api/books/book-1",
            cookies: ["valid"],
        },
        stubs: { getFile: { base64: PDF_FILE_BASE64 } },
        db: [authUser, bookById(BOOK_ROW)],
    },
    {
        id: "books-file-conditional-etag",
        env: "test",
        request: {
            method: "GET",
            path: "/api/books/book-1",
            cookies: ["valid"],
            ifNoneMatchFrom: "books-file-pdf",
        },
        stubs: { getFile: { base64: PDF_FILE_BASE64 } },
        db: [authUser, bookById(BOOK_ROW)],
    },

    {
        id: "progress-get-missing-book",
        env: "test",
        request: {
            method: "GET",
            path: "/api/book-1/progress",
            cookies: ["valid"],
        },
        db: [authUser, emptyBookSelect],
    },
    {
        id: "progress-get-nonowner",
        env: "test",
        request: {
            method: "GET",
            path: "/api/book-1/progress",
            cookies: ["valid"],
        },
        db: [authUser, emptyBookSelect],
    },
    {
        id: "progress-get-none",
        env: "test",
        request: {
            method: "GET",
            path: "/api/book-1/progress",
            cookies: ["valid"],
        },
        db: [authUser, bookById(BOOK_ROW), progressSelect([])],
    },
    {
        id: "progress-get-existing",
        env: "test",
        request: {
            method: "GET",
            path: "/api/book-1/progress",
            cookies: ["valid"],
        },
        db: [authUser, bookById(BOOK_ROW), progressSelect([PROGRESS_ROW])],
    },
    {
        id: "progress-get-db-error",
        env: "production",
        request: {
            method: "GET",
            path: "/api/book-1/progress",
            cookies: ["valid"],
        },
        db: [
            authUser,
            { op: "select", table: "books", error: "connection reset" },
        ],
    },
    {
        id: "progress-post-db-error",
        env: "production",
        request: {
            method: "POST",
            path: "/api/book-1/progress",
            cookies: ["valid"],
            body: {
                kind: "urlencoded",
                fields: { progress_block: "p1", progress_chapter: "c1" },
            },
        },
        db: [
            authUser,
            bookById(BOOK_ROW),
            { op: "insert", table: "progress", error: "connection reset" },
        ],
    },

    {
        id: "chat-create-empty-body",
        env: "test",
        request: {
            method: "POST",
            path: "/api/book/book-1/conversations",
            cookies: ["valid"],
            body: { kind: "json", value: {} },
        },
        db: [authUser],
    },
    {
        id: "chat-create-blank-message",
        env: "test",
        request: {
            method: "POST",
            path: "/api/book/book-1/conversations",
            cookies: ["valid"],
            body: { kind: "json", value: { message: "   " } },
        },
        db: [authUser],
    },
    {
        id: "chat-create-unsupported-model",
        env: "test",
        request: {
            method: "POST",
            path: "/api/book/book-1/conversations",
            cookies: ["valid"],
            body: {
                kind: "json",
                value: { message: "hello", model: "gpt-99-turbo" },
            },
        },
        db: [authUser],
    },
    {
        id: "chat-append-unsupported-resource",
        env: "test",
        request: {
            method: "POST",
            path: "/api/widget/book-1/conversations/conv-1/messages",
            cookies: ["valid"],
            body: { kind: "json", value: { message: "hello" } },
        },
        db: [authUser],
    },
    {
        id: "chat-list-missing-book",
        env: "test",
        request: {
            method: "GET",
            path: "/api/book/missing-book/conversations",
            cookies: ["valid"],
        },
        db: [authUser, emptyBookSelect],
    },
    {
        id: "chat-list-nonowner",
        env: "test",
        request: {
            method: "GET",
            path: "/api/book/book-1/conversations",
            cookies: ["valid"],
        },
        db: [authUser, bookRefSelect(OTHER_BOOK_ID_REF_ROW)],
    },
    {
        id: "chat-details-missing",
        env: "test",
        request: {
            method: "GET",
            path: "/api/book/book-1/conversations/conv-missing",
            cookies: ["valid"],
        },
        db: [
            authUser,
            bookRefSelect(BOOK_ID_REF_ROW),
            { op: "select", table: "conversations", rows: [] },
        ],
    },
    {
        id: "chat-details-wrong-scope",
        env: "test",
        request: {
            method: "GET",
            path: "/api/book/book-1/conversations/conv-other",
            cookies: ["valid"],
        },
        db: [
            authUser,
            bookRefSelect(BOOK_ID_REF_ROW),
            { op: "select", table: "conversations", rows: [] },
        ],
    },
];

const MULTIPART_BOUNDARY = "----reader-parity-boundary-7f3c9a21";

export const buildMultipartBody = (
    parts: MultipartPart[],
    truncateAt?: number
): { body: Buffer; contentType: string } => {
    const chunks: Buffer[] = [];
    for (const part of parts) {
        const headers = [
            `--${MULTIPART_BOUNDARY}`,
            `Content-Disposition: form-data; name="${part.name}"${
                part.filename ? `; filename="${part.filename}"` : ""
            }`,
        ];
        if (part.contentType) {
            headers.push(`Content-Type: ${part.contentType}`);
        }
        chunks.push(Buffer.from(`${headers.join("\r\n")}\r\n\r\n`, "utf8"));
        chunks.push(
            part.base64
                ? Buffer.from(part.base64, "base64")
                : Buffer.from(part.text ?? "", "utf8")
        );
        chunks.push(Buffer.from("\r\n", "utf8"));
    }
    chunks.push(Buffer.from(`--${MULTIPART_BOUNDARY}--\r\n`, "utf8"));
    let body = Buffer.concat(chunks);
    if (typeof truncateAt === "number" && truncateAt < body.length) {
        body = body.subarray(0, truncateAt);
    }
    return {
        body,
        contentType: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
    };
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const originValue = (spec: OriginSpec): string | null => {
    switch (spec) {
        case "trusted":
            return FRONTEND_URL;
        case "untrusted":
            return UNTRUSTED_ORIGIN;
        case "local":
            return LOCAL_ORIGIN;
        case "none":
            return null;
    }
};

const cookieName = (spec: CookieSpec) =>
    spec.endsWith("Prod") ? PROD_AUTH_COOKIE : DEV_AUTH_COOKIE;

const cookieTokenKind = (spec: CookieSpec): "valid" | "expired" | "tampered" =>
    spec.startsWith("valid")
        ? "valid"
        : spec.startsWith("expired")
          ? "expired"
          : "tampered";

export interface ResolvedRequestTokens {
    valid: string;
    expired: string;
    tampered: string;
}

export const buildScenarioRequest = (
    scenario: HttpParityScenario,
    tokens: ResolvedRequestTokens,
    resolveEtag: (scenarioId: string) => string | undefined
): {
    url: string;
    init: { method: string; headers: Record<string, string>; body?: Buffer };
} => {
    const req = scenario.request;
    const headers: Record<string, string> = { ...(req.headers ?? {}) };

    const origin = originValue(
        req.origin ?? (SAFE_METHODS.has(req.method) ? "none" : "trusted")
    );
    if (origin !== null) headers.origin = origin;

    if (req.cookies?.length) {
        headers.cookie = req.cookies
            .map(
                (spec) => `${cookieName(spec)}=${tokens[cookieTokenKind(spec)]}`
            )
            .join("; ");
    }

    if (req.ifNoneMatchFrom) {
        const etag = resolveEtag(req.ifNoneMatchFrom);
        if (!etag) {
            throw new Error(
                `Scenario ${scenario.id}: missing captured etag from ${req.ifNoneMatchFrom}`
            );
        }
        headers["if-none-match"] = etag;
    }

    let body: Buffer | undefined;
    if (req.body) {
        switch (req.body.kind) {
            case "json":
                body = Buffer.from(JSON.stringify(req.body.value), "utf8");
                headers["content-type"] = "application/json";
                break;
            case "raw":
                body = Buffer.from(req.body.text, "utf8");
                headers["content-type"] = req.body.contentType;
                break;
            case "padded": {
                const padLength = Math.max(
                    0,
                    req.body.length -
                        req.body.prefix.length -
                        req.body.suffix.length
                );
                body = Buffer.from(
                    req.body.prefix +
                        req.body.padChar.repeat(padLength) +
                        req.body.suffix,
                    "utf8"
                );
                headers["content-type"] = req.body.contentType;
                break;
            }
            case "urlencoded": {
                const usp = new URLSearchParams(req.body.fields);
                body = Buffer.from(usp.toString(), "utf8");
                headers["content-type"] = "application/x-www-form-urlencoded";
                break;
            }
            case "multipart": {
                const built = buildMultipartBody(
                    req.body.parts,
                    req.body.truncateAt
                );
                body = built.body;
                headers["content-type"] = built.contentType;
                break;
            }
        }
    }

    return {
        url: req.path,
        init: { method: req.method, headers, ...(body ? { body } : {}) },
    };
};

export interface HttpCapture {
    id: string;
    status: number;
    headers: Record<string, string | null>;
    cookies: string[];
    body: unknown;
    effects: unknown[];
}

export const CAPTURED_HEADER_NAMES = [
    "content-type",
    "cache-control",
    "x-content-type-options",
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "vary",
    "retry-after",
] as const;

export interface RawFetchResult {
    status: number;
    headerValue(name: string): string | null;
    cookies: string[];
    bodyBytes: Buffer;
}

const isJsonContentType = (contentType: string | null) =>
    Boolean(contentType && /(^|\+|\/)json\b/i.test(contentType));

const isSseContentType = (contentType: string | null) =>
    Boolean(contentType && /text\/event-stream/i.test(contentType));

const isTextualContentType = (contentType: string | null) =>
    Boolean(
        contentType &&
            /(^text\/|json|html|urlencoded|xml|javascript|\+xml)/i.test(
                contentType
            )
    );

export const parseSseFrames = (text: string): unknown[] => {
    const frames: unknown[] = [];
    for (const block of text.split("\n\n")) {
        const dataLines = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""));
        if (!dataLines.length) continue;
        const data = dataLines.join("\n");
        if (data === "[DONE]") {
            frames.push("[DONE]");
            continue;
        }
        frames.push(JSON.parse(data));
    }
    return frames;
};

export const decodeCapturedBody = (
    contentType: string | null,
    bodyBytes: Buffer
): unknown => {
    if (!bodyBytes.length) return null;
    const text = bodyBytes.toString("utf8");
    if (isSseContentType(contentType)) return parseSseFrames(text);
    if (isJsonContentType(contentType)) {
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }
    if (isTextualContentType(contentType)) return text;
    return { encoding: "base64", data: bodyBytes.toString("base64") };
};

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const NOW_TOLERANCE_MS = 120_000;

const decodeJwtParts = (
    token: string
): {
    header: Record<string, unknown>;
    payload: Record<string, unknown>;
} | null => {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
        const decode = (segment: string) =>
            JSON.parse(
                Buffer.from(
                    segment.replace(/-/g, "+").replace(/_/g, "/"),
                    "base64"
                ).toString("utf8")
            ) as Record<string, unknown>;
        return { header: decode(parts[0]), payload: decode(parts[1]) };
    } catch {
        return null;
    }
};

const isAuthSessionCookieName = (name: string) =>
    name === PROD_AUTH_COOKIE || name === DEV_AUTH_COOKIE;

export const normalizeCookie = (
    cookie: string,
    capturedAtMs: number
): string => {
    const segments = cookie.split(";");
    const [nameValue, ...attributes] = segments;
    const separator = nameValue.indexOf("=");
    if (separator < 0) return cookie;
    const name = nameValue.slice(0, separator).trim();
    const value = nameValue.slice(separator + 1);

    let normalizedNameValue = nameValue;
    if (isAuthSessionCookieName(name) && value !== "") {
        const raw = decodeURIComponent(value);
        const decoded = decodeJwtParts(raw);
        const claimKeys = decoded ? Object.keys(decoded.payload).sort() : [];
        const signatureValid = (() => {
            if (!decoded) return false;
            const parts = raw.split(".");
            const expected = createHmac("sha256", JWT_SECRET)
                .update(`${parts[0]}.${parts[1]}`)
                .digest("base64url");
            const actual = Buffer.from(parts[2], "utf8");
            const wanted = Buffer.from(expected, "utf8");
            return (
                actual.length === wanted.length &&
                timingSafeEqual(actual, wanted)
            );
        })();
        const validLoginJwt =
            Boolean(decoded) &&
            signatureValid &&
            decoded!.header.alg === "HS256" &&
            claimKeys.length === 3 &&
            claimKeys[0] === "exp" &&
            claimKeys[1] === "iat" &&
            claimKeys[2] === "userId" &&
            decoded!.payload.userId === OWNER.id &&
            typeof decoded!.payload.exp === "number" &&
            typeof decoded!.payload.iat === "number" &&
            decoded!.payload.exp - decoded!.payload.iat ===
                AUTH_COOKIE_MAX_AGE_SECONDS &&
            Math.abs((decoded!.payload.iat as number) * 1000 - capturedAtMs) <=
                NOW_TOLERANCE_MS;
        if (!validLoginJwt) {
            throw new Error(
                `Unverifiable auth cookie value for ${name} in capture`
            );
        }
        normalizedNameValue = `${name}=<JWT>`;
    }

    const normalizedAttributes = attributes.map((attribute) => {
        const trimmed = attribute.trim();
        if (/^expires=/i.test(trimmed)) {
            const rawDate = trimmed.slice("expires=".length);
            const expiresMs = Date.parse(rawDate);
            const hasSevenDayMaxAge = attributes.some((attr) =>
                /^max-age=604800$/i.test(attr.trim())
            );
            if (hasSevenDayMaxAge) {
                if (
                    !Number.isFinite(expiresMs) ||
                    Math.abs(
                        expiresMs -
                            (capturedAtMs + AUTH_COOKIE_MAX_AGE_SECONDS * 1000)
                    ) > 2000
                ) {
                    throw new Error(
                        `Unverifiable login cookie expiry: ${rawDate}`
                    );
                }
                return " Expires=<LOGIN_EXPIRY>";
            }
        }
        return attribute;
    });

    return [normalizedNameValue, ...normalizedAttributes].join(";");
};

export const createValueNormalizer = (capturedAtMs: number) => {
    const uuidMap = new Map<string, string>();
    const normalizeValue = (value: unknown): unknown => {
        if (typeof value === "string") {
            if (UUID_RE.test(value)) {
                let token = uuidMap.get(value);
                if (!token) {
                    token = `<UUID${uuidMap.size + 1}>`;
                    uuidMap.set(value, token);
                }
                return token;
            }
            if (ISO_DATE_RE.test(value)) {
                const parsed = Date.parse(value);
                if (
                    Number.isFinite(parsed) &&
                    Math.abs(parsed - capturedAtMs) <= NOW_TOLERANCE_MS
                ) {
                    return "<NOW>";
                }
            }
            return value;
        }
        if (Array.isArray(value)) return value.map(normalizeValue);
        if (value && typeof value === "object") {
            const out: Record<string, unknown> = {};
            for (const [key, child] of Object.entries(
                value as Record<string, unknown>
            )) {
                out[key] = normalizeValue(child);
            }
            return out;
        }
        return value;
    };
    return normalizeValue;
};

export const buildCapture = (args: {
    id: string;
    status: number;
    headerValue: (name: string) => string | null;
    cookies: string[];
    contentType: string | null;
    bodyBytes: Buffer;
    effects: unknown[];
    capturedAtMs: number;
}): HttpCapture => {
    const normalizeValue = createValueNormalizer(args.capturedAtMs);
    const headers: Record<string, string | null> = {};
    for (const name of CAPTURED_HEADER_NAMES) {
        headers[name] = args.headerValue(name);
    }
    return {
        id: args.id,
        status: args.status,
        headers,
        cookies: args.cookies.map((cookie) =>
            normalizeCookie(cookie, args.capturedAtMs)
        ),
        body: normalizeValue(
            decodeCapturedBody(args.contentType, args.bodyBytes)
        ),
        effects: normalizeValue(args.effects) as unknown[],
    };
};
