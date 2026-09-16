import type { NestExpressApplication } from "@nestjs/platform-express";
import chatRoutes from "../routes/Chat.routes";

export const mountLegacyRouters = (app: NestExpressApplication) => {
    app.use("/api", chatRoutes);
};
