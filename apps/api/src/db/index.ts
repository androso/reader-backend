import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { configDotenv } from "dotenv";

configDotenv();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
});

export const db = drizzle(pool);

export const closeDatabasePool = () => pool.end();
