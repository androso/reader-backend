import express from "express";
import dotenv from "dotenv";
import authRoutes from "./routes/Auth.routes";
import userRoutes from "./routes/User.routes";
import bookRoutes from "./routes/Book.routes";
import chatRoutes from "./routes/Chat.routes";
import healthRoutes from "./routes/Health.routes";
import tracker from "./routes/Tracker.routes";
import cors from "cors";
import { logger } from "./middleware/logger";
import { enforceTrustedOrigin } from "./middleware/csrf";
import { authRateLimit } from "./middleware/rateLimit";
dotenv.config();

const app = express();
const allowedOrigins = [
    process.env.FRONTEND_URL,
    ...(process.env.NODE_ENV === "production"
        ? []
        : [
              "http://localhost:5173",
              "http://127.0.0.1:5173",
              "http://localhost:3001",
              "http://127.0.0.1:3001",
          ]),
].filter(Boolean);

if (allowedOrigins.length === 0) {
    console.warn("No CORS origins configured");
}

app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
                return;
            }

            callback(new Error(`CORS origin not allowed: ${origin}`));
        },
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: true,
    })
);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(logger);
app.use(enforceTrustedOrigin);

app.get("/", (req, res) => {
    res.send("Hello World");
});

app.use("/health", healthRoutes);

// auth routes
app.use("/api/auth", authRateLimit, authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/books", bookRoutes);
app.use("/api", chatRoutes);
app.use("/api", tracker);

app.use(
    (
        error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
    ) => {
        console.error("Unhandled request error", error);
        if (!res.headersSent)
            res.status(500).json({ error: "Internal server error" });
    }
);
export default app;
