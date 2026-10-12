import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { configDotenv } from "dotenv";

configDotenv();

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
});

export const db = drizzle(pool);

export const closeDatabasePool = () => pool.end();
