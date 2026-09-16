import type { NestExpressApplication } from "@nestjs/platform-express";
import bookRoutes from "../routes/Book.routes";
import chatRoutes from "../routes/Chat.routes";
import trackerRoutes from "../routes/Tracker.routes";

export const mountLegacyRouters = (app: NestExpressApplication) => {
    app.use("/api/books", bookRoutes);
    app.use("/api", chatRoutes);
    app.use("/api", trackerRoutes);
};
