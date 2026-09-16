import type { NestExpressApplication } from "@nestjs/platform-express";
import authRoutes from "../routes/Auth.routes";
import userRoutes from "../routes/User.routes";
import bookRoutes from "../routes/Book.routes";
import chatRoutes from "../routes/Chat.routes";
import healthRoutes from "../routes/Health.routes";
import trackerRoutes from "../routes/Tracker.routes";
import { authRateLimit } from "../middleware/rateLimit";

export const mountLegacyRouters = (app: NestExpressApplication) => {
    app.use("/health", healthRoutes);
    app.use("/api/auth", authRateLimit, authRoutes);
    app.use("/api/user", userRoutes);
    app.use("/api/books", bookRoutes);
    app.use("/api", chatRoutes);
    app.use("/api", trackerRoutes);
};
