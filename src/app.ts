import express from "express";
import dotenv from "dotenv";
import path from "path";
import authRoutes from "./routes/Auth.routes";
import userRoutes from "./routes/User.routes";
import bookRoutes from "./routes/Book.routes";
import chatRoutes from "./routes/Chat.routes";
import tracker from "./routes/Tracker.routes";
import cors from "cors";
import { logger } from "./middleware/logger";
import { queryController } from "./controllers/QueryControllers";
dotenv.config();

const app = express();
const isProduction = process.env.NODE_ENV === "production";

if (!process.env.FRONTEND_URL && !isProduction) {
    console.warn("FRONTEND_URL not set, CORS is using default frontend URL");
}

app.use(
    cors({
        origin: process.env.FRONTEND_URL,
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: true,
    })
);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(logger);

// API endpoints
app.post("/query", (req, res) => queryController.handleQuery(req, res));
app.delete(
    "/collection/:collectionName",
    queryController.handleDelete.bind(queryController)
);

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/books", bookRoutes);
app.use("/api", chatRoutes);
app.use("/api", tracker);

// Serve static files in production
if (isProduction) {
    app.use(express.static(path.join(__dirname, "../public")));

    // For any other route, serve the React app
    app.get("*", (req, res) => {
        res.sendFile(path.join(__dirname, "../public/index.html"));
    });
} else {
    // In development, show a message for the API root
    app.get("/", (req, res) => {
        res.send(
            "API is running. Frontend is available at http://localhost:5173"
        );
    });
}
export default app;
