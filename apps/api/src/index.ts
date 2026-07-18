import "./observability/bootstrap";
import app from "./app";
import { shutdownLangfuseTracing } from "./observability/langfuse";
import swaggerdocs from "./utils/swagger";
import { closeRagRerankShadowQueue } from "./services/RagShadowQueue";

const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = 10000;

const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    swaggerdocs(app, PORT);
});

let isShuttingDown = false;

const shutdown = (signal: NodeJS.Signals) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`Received ${signal}; closing API server`);

    const timeout = setTimeout(() => {
        console.error("Graceful shutdown timed out");
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timeout.unref();

    server.close(async (error) => {
        if (error) {
            console.error("Error closing API server", error);
        }

        await Promise.all([
            shutdownLangfuseTracing(),
            closeRagRerankShadowQueue(),
        ]);
        clearTimeout(timeout);
        process.exit(error ? 1 : 0);
    });
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
