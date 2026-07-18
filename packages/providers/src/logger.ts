export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const getLevel = (): LogLevel => {
    const env = process.env.LOG_LEVEL?.toLowerCase();
    if (env && env in LEVELS) return env as LogLevel;
    return process.env.NODE_ENV === "production" ? "info" : "debug";
};

const currentLevel = getLevel();
const shouldLog = (level: LogLevel) => LEVELS[level] >= LEVELS[currentLevel];

const formatMessage = (
    level: LogLevel,
    component: string,
    message: string,
    meta?: Record<string, unknown>
) => {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        component,
        message,
        ...(meta ? { meta } : {}),
    };
    return JSON.stringify(entry);
};

const log = (
    level: LogLevel,
    component: string,
    message: string,
    meta?: Record<string, unknown>
) => {
    if (!shouldLog(level)) return;

    const output = formatMessage(level, component, message, meta);

    switch (level) {
        case "error":
            console.error(output);
            return;
        case "warn":
            console.warn(output);
            return;
        case "debug":
            console.debug(output);
            return;
        default:
            console.log(output);
    }
};

export interface Logger {
    debug: (message: string, meta?: Record<string, unknown>) => void;
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
}

export const contentFreeQueryLogMetadata = (
    query: string,
    metadata: Record<string, unknown> = {}
) => ({
    ...metadata,
    queryLength: query.length,
});

export const createLogger = (component: string): Logger => ({
    debug: (message, meta) => log("debug", component, message, meta),
    info: (message, meta) => log("info", component, message, meta),
    warn: (message, meta) => log("warn", component, message, meta),
    error: (message, meta) => log("error", component, message, meta),
});

export const logger = createLogger("reader");
