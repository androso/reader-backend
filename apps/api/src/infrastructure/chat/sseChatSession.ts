import type { Request, Response } from "express";
import { ChatCancelledError, type ChatStreamEvent } from "@reader/domain";
import type { ChatEventSink } from "@reader/application";

export type SseChatSession = {
    signal: AbortSignal;
    sink: ChatEventSink;
    open(): void;
    fail(payload: Record<string, unknown>): Promise<void>;
    dispose(): void;
};

export const createSseChatSession = (
    req: Request,
    res: Response
): SseChatSession => {
    const controller = new AbortController();
    let terminated = false;
    let terminalRequested = false;
    let opened = false;
    let writeChain: Promise<void> = Promise.resolve();
    let drainWaiter: (() => void) | null = null;

    // body-parser auto-destroys the fully consumed request stream, so it isn't a disconnect signal.
    const isAlreadyDisconnected = () =>
        req.aborted ||
        req.socket?.destroyed === true ||
        res.destroyed ||
        res.writableEnded;

    const cleanup = () => {
        req.removeListener("aborted", onAborted);
        res.removeListener("close", onClose);
        res.removeListener("drain", onDrain);
    };

    const terminate = () => {
        if (terminated) return;
        terminated = true;
        cleanup();
        drainWaiter?.();
        drainWaiter = null;
        if (!controller.signal.aborted) controller.abort();
    };

    const onAborted = () => terminate();
    const onClose = () => {
        if (!res.writableFinished) terminate();
    };
    const onDrain = () => {
        drainWaiter?.();
        drainWaiter = null;
    };

    req.on("aborted", onAborted);
    res.on("close", onClose);
    res.on("drain", onDrain);

    if (isAlreadyDisconnected()) terminate();

    const open = () => {
        if (
            terminated ||
            controller.signal.aborted ||
            isAlreadyDisconnected()
        ) {
            terminate();
            throw new ChatCancelledError();
        }
        if (opened) return;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        opened = true;
    };

    const waitForDrain = () =>
        new Promise<void>((resolve, reject) => {
            if (
                terminated ||
                controller.signal.aborted ||
                res.destroyed ||
                res.writableEnded
            ) {
                terminate();
                reject(new ChatCancelledError());
                return;
            }
            drainWaiter = () => {
                if (terminated || controller.signal.aborted) {
                    reject(new ChatCancelledError());
                } else {
                    resolve();
                }
            };
        });

    const enqueue = (operation: () => Promise<void>) => {
        const result = writeChain.then(operation);
        writeChain = result.catch(() => undefined);
        return result;
    };

    const writeFrame = async (frame: string) => {
        if (
            !opened ||
            terminated ||
            controller.signal.aborted ||
            res.destroyed ||
            res.writableEnded
        ) {
            if (res.destroyed || res.writableEnded) terminate();
            throw new ChatCancelledError();
        }
        if (!res.write(frame)) await waitForDrain();
        if (
            terminated ||
            controller.signal.aborted ||
            res.destroyed ||
            res.writableEnded
        ) {
            if (res.destroyed || res.writableEnded) terminate();
            throw new ChatCancelledError();
        }
    };

    const sink: ChatEventSink = {
        emit(event: ChatStreamEvent) {
            if (terminated || terminalRequested) {
                return Promise.reject(new ChatCancelledError());
            }
            return enqueue(() =>
                writeFrame(`data: ${JSON.stringify(event)}\n\n`)
            );
        },
        complete() {
            if (terminalRequested) return writeChain;
            terminalRequested = true;
            return enqueue(async () => {
                try {
                    await writeFrame("data: [DONE]\n\n");
                    if (!res.writableEnded) res.end();
                } finally {
                    terminated = true;
                    cleanup();
                }
            });
        },
    };

    const fail = (payload: Record<string, unknown>) => {
        if (terminalRequested) return writeChain;
        terminalRequested = true;
        return enqueue(async () => {
            try {
                await writeFrame(`data: ${JSON.stringify(payload)}\n\n`);
                if (!res.writableEnded) res.end();
            } finally {
                terminated = true;
                cleanup();
            }
        });
    };

    return {
        signal: controller.signal,
        sink,
        open,
        fail,
        dispose() {
            if (!terminated) terminate();
            else cleanup();
        },
    };
};
