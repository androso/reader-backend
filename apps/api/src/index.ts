import "./observability/bootstrap";
import "reflect-metadata";
import { createApp } from "./bootstrap";
import { shutdownLangfuseTracing } from "./observability/langfuse";
import { closeRagRerankShadowQueue } from "./services/RagShadowQueue";

const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = 10000;

let isShuttingDown = false;

const shutdown = (
    signal: NodeJS.Signals,
    app: { close: () => Promise<void> }
) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`Received ${signal}; closing API server`);

    const timeout = setTimeout(() => {
        console.error("Graceful shutdown timed out");
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timeout.unref();

    app.close()
        .then(async () => {
            await Promise.all([
                shutdownLangfuseTracing(),
                closeRagRerankShadowQueue(),
            ]);
            clearTimeout(timeout);
            process.exit(0);
        })
        .catch(async (error) => {
            console.error("Error closing API server", error);
            await Promise.all([
                shutdownLangfuseTracing(),
                closeRagRerankShadowQueue(),
            ]);
            clearTimeout(timeout);
            process.exit(1);
        });
};

createApp().then((app) => {
    app.listen(PORT).then(() => {
        console.log(`Server running on port ${PORT}`);
    });

    process.once("SIGTERM", (signal) => shutdown(signal, app));
    process.once("SIGINT", (signal) => shutdown(signal, app));
});
