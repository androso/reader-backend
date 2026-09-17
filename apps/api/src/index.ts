import "./observability/bootstrap";
import "reflect-metadata";
import { defaultApiResources, runApiProcess } from "./api-lifecycle";

const PORT = process.env.PORT || 3000;

const { ready } = runApiProcess({
    createApp: async () => (await import("./bootstrap")).createApp(),
    resources: defaultApiResources,
    port: PORT,
});
void ready.catch(() => {});
