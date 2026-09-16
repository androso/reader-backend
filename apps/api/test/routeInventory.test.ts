import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";
process.env.FRONTEND_URL = "http://localhost:5173";

const { createApp } =
    require("../src/bootstrap") as typeof import("../src/bootstrap");

type NestApp = Awaited<ReturnType<typeof createApp>>;

type RouteLayer = {
    route?: {
        path?: unknown;
        methods?: Record<string, boolean>;
    };
};

let app: NestApp;

before(async () => {
    app = await createApp();
    await app.listen(0);
});

after(async () => {
    await app.close();
});

const collectRoutes = () => {
    const expressApp = app.getHttpAdapter().getInstance() as {
        router?: { stack?: RouteLayer[] };
        _router?: { stack?: RouteLayer[] };
    };
    const router = expressApp.router ?? expressApp._router;
    assert.ok(router, "express router not exposed on the adapter instance");

    const routes: { method: string; path: string }[] = [];
    for (const layer of router.stack ?? []) {
        if (!layer.route) continue;
        const rawPath = layer.route.path;
        const path =
            typeof rawPath === "string"
                ? rawPath
                : rawPath instanceof RegExp
                  ? rawPath.source
                  : String(rawPath);
        if (path.startsWith("/api-docs")) continue;
        for (const method of Object.keys(layer.route.methods ?? {})) {
            routes.push({ method: method.toUpperCase(), path });
        }
    }
    return routes;
};

const EXPECTED_ROUTES = [
    "GET /",
    "GET /health",
    "POST /api/auth/google",
    "POST /api/auth/dev",
    "POST /api/auth/logout",
    "GET /api/user",
    "POST /api/books",
    "GET /api/books",
    "POST /api/books/:id/retry",
    "GET /api/books/:id/status",
    "GET /api/books/:id",
    "DELETE /api/books/:id",
    "POST /api/:resourceType/:id/conversations",
    "GET /api/:resourceType/:id/conversations",
    "POST /api/:resourceType/:rid/conversations/:cid/messages",
    "GET /api/:resourceType/:id/conversations/:conversationId",
    "GET /api/:rid/progress",
    "POST /api/:rid/progress",
];

test("the registered route set matches the frozen parity spec", () => {
    const routes = collectRoutes();
    const actual = routes.map(({ method, path }) => `${method} ${path}`);
    assert.deepEqual([...actual].sort(), [...EXPECTED_ROUTES].sort());
});

test("books routes are registered before chat routes, chat before tracker", () => {
    const paths = collectRoutes().map(({ path }) => path);
    const firstBooksRoute = paths.findIndex((p) => p.startsWith("/api/books"));
    const firstChatRoute = paths.findIndex((p) => p.includes("/conversations"));
    const firstTrackerRoute = paths.findIndex((p) => p.endsWith("/progress"));
    assert.ok(firstBooksRoute >= 0, "no books route found");
    assert.ok(
        firstChatRoute > firstBooksRoute,
        "chat routes must come after books routes"
    );
    assert.ok(
        firstTrackerRoute > firstChatRoute,
        "tracker routes must come after chat routes"
    );
});
