import assert from "node:assert/strict";
import test from "node:test";
import { HealthController } from "../src/health/health.controller";
import { createTestApp } from "./helpers/nestApp";

test("health route reports ok", async () => {
    const testApp = await createTestApp({ controllers: [HealthController] });
    try {
        const res = await fetch(`${testApp.baseUrl}/health`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { status: "ok" });
    } finally {
        await testApp.close();
    }
});
