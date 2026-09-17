import "reflect-metadata";
import type { INestApplicationContext } from "@nestjs/common";
import { createWorkerApp } from "./bootstrap";

export interface WorkerProcessSignals {
    on(signal: NodeJS.Signals, listener: () => void): void;
    removeListener(signal: NodeJS.Signals, listener: () => void): void;
}

export interface WorkerProcessDependencies {
    createApp: () => Promise<Pick<INestApplicationContext, "close">>;
    signals: WorkerProcessSignals;
    exit: (code: number) => void;
    logError: (...args: unknown[]) => void;
}

export const runWorkerProcess = (
    deps: WorkerProcessDependencies
): Promise<void> => {
    let finished = false;
    let closing: Promise<void> | undefined;
    let resolveFinished!: () => void;
    const finishedPromise = new Promise<void>((resolve) => {
        resolveFinished = resolve;
    });

    const finish = (code: number, error?: unknown) => {
        if (finished) return;
        finished = true;
        if (error !== undefined) deps.logError(error);
        deps.signals.removeListener("SIGINT", onSignal);
        deps.signals.removeListener("SIGTERM", onSignal);
        deps.exit(code);
        resolveFinished();
    };

    const appPromise = Promise.resolve().then(() => deps.createApp());

    const onSignal = () => {
        closing ??= appPromise.then((app) => app.close());
        void closing.then(
            () => finish(0),
            (error: unknown) => finish(1, error)
        );
    };

    deps.signals.on("SIGINT", onSignal);
    deps.signals.on("SIGTERM", onSignal);

    void appPromise.then(
        () => undefined,
        (error: unknown) => finish(1, error)
    );

    return finishedPromise;
};

const defaultWorkerProcessDependencies: WorkerProcessDependencies = {
    createApp: createWorkerApp,
    signals: {
        on: (signal, listener) => {
            process.on(signal, listener);
        },
        removeListener: (signal, listener) => {
            process.removeListener(signal, listener);
        },
    },
    exit: (code) => process.exit(code),
    logError: (...args) => console.error(...args),
};

if (require.main === module) {
    void runWorkerProcess(defaultWorkerProcessDependencies);
}
