import assert from "node:assert/strict";
import test from "node:test";
import { Controller, Get, UseGuards } from "@nestjs/common";
import { AuthRateLimitGuard } from "../src/common/guards/rate-limit.guard";
import { createTestApp } from "./helpers/nestApp";

@Controller("limited")
@UseGuards(AuthRateLimitGuard)
class LimitedController {
    @Get()
    get() {
        return { ok: true };
    }
}

test("rate limit guard passes requests through without REDIS_URL", async () => {
    const testApp = await createTestApp({ controllers: [LimitedController] });
    try {
        const res = await fetch(`${testApp.baseUrl}/limited`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true });
    } finally {
        await testApp.close();
    }
});
