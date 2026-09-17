import type { Database } from "../database/database.module";
import { db } from "../db";
import {
    generateToken,
    getOrCreateDevUser,
    verifyGoogleToken,
} from "../services/AuthService";

export const AUTH_OPERATIONS = "AUTH_OPERATIONS";

export const createAuthOperations = (database: Database = db) => ({
    verifyGoogleToken,
    generateToken,
    getOrCreateDevUser: () => getOrCreateDevUser(database),
});

export type AuthOperations = ReturnType<typeof createAuthOperations>;
