export const throwIfLockLost = (signal: AbortSignal): void => {
    if (signal.aborted) throw signal.reason;
};
