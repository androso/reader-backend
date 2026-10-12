import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ChatCancelledError } from "@reader/domain";

process.env.JWT_SECRET ??= "reader-api-test-secret";

const { createSseChatSession } =
    require("../src/infrastructure/chat/sseChatSession") as typeof import("../src/infrastructure/chat/sseChatSession");

class FakeRequest extends EventEmitter {}

class FakeResponse extends EventEmitter {
    headers: Record<string, string> = {};
    frames: string[] = [];
    writableEnded = false;
    writableFinished = false;
    writeResult = true;
    endCount = 0;

    setHeader(name: string, value: string) {
        this.headers[name] = value;
    }

    write(frame: string) {
        this.frames.push(frame);
        return this.writeResult;
    }

    end() {
        this.endCount += 1;
        this.writableEnded = true;
        this.writableFinished = true;
    }
}

const createSession = () => {
    const req = new FakeRequest();
    const res = new FakeResponse();
    const request = req as never;
    const response = res as never;
    return { req, res, session: createSseChatSession(request, response) };
};

test("SSE writes wait for drain when the response applies backpressure", async () => {
    const { res, session } = createSession();
    res.writeResult = false;

    let settled = false;
    const write = session.sink.emit({ content: "token" }).then(() => {
        settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    res.emit("drain");
    await write;
    assert.equal(settled, true);
    assert.deepEqual(res.frames, ['data: {"content":"token"}\n\n']);

    res.writeResult = true;
    await session.sink.complete();
    assert.equal(res.endCount, 1);
});

test("SSE close while waiting for drain aborts and rejects the pending write", async () => {
    const { req, res, session } = createSession();
    const baselineAborted = req.listenerCount("aborted") - 1;
    const baselineClose = res.listenerCount("close") - 1;
    res.writeResult = false;
    const write = session.sink.emit({ content: "blocked" });
    await new Promise((resolve) => setImmediate(resolve));
    res.emit("close");

    await assert.rejects(write, ChatCancelledError);
    assert.equal(session.signal.aborted, true);
    assert.equal(req.listenerCount("aborted"), baselineAborted);
    assert.equal(res.listenerCount("close"), baselineClose);
    await assert.rejects(
        session.sink.emit({ content: "after close" }),
        ChatCancelledError
    );
});

test("a close after the response has finished is not a premature abort", async () => {
    const { req, res, session } = createSession();
    await session.sink.complete();
    assert.equal(res.endCount, 1);
    res.emit("close");
    assert.equal(session.signal.aborted, false);
    assert.equal(req.listenerCount("aborted"), 0);
    assert.equal(res.listenerCount("close"), 0);
});

test("SSE fail and complete share one terminal path and clean up listeners", async () => {
    const { req, res, session } = createSession();
    await session.sink.emit({ content: "before" });
    await session.fail({ error: "An error occurred" });
    await session.sink.complete();
    await session.fail({ error: "duplicate" });

    assert.equal(res.endCount, 1);
    assert.equal(res.frames.length, 2);
    assert.deepEqual(res.frames, [
        'data: {"content":"before"}\n\n',
        'data: {"error":"An error occurred"}\n\n',
    ]);
    assert.equal(req.listenerCount("aborted"), 0);
    assert.equal(res.listenerCount("close"), 0);
    assert.equal(res.listenerCount("drain"), 0);
});

test("SSE cancellation does not create an unhandled rejection", async () => {
    const { res, session } = createSession();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
        res.writeResult = false;
        const write = session.sink.emit({ content: "blocked" });
        await new Promise((resolve) => setImmediate(resolve));
        res.emit("close");
        await assert.rejects(write, ChatCancelledError);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(unhandled, []);
    } finally {
        process.removeListener("unhandledRejection", onUnhandled);
    }
});
