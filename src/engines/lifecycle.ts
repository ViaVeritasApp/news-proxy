import { debug } from '../log.js';

// Structural, so it fits both puppeteer's Browser and the puppeteer-core one cloak returns.
interface Closable {
    close(): Promise<void>;
    process(): { kill(signal: NodeJS.Signals): unknown } | null;
}

// A Chrome that stopped answering CDP never resolves close(), and the browser would
// outlive the request that opened it.
const CLOSE_TIMEOUT = 10_000;

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

// Graceful close on a budget, then SIGKILL. Never throws: callers use it on paths that
// already have an error to report.
export const closeBrowser = async (browser: Closable, name: string): Promise<void> => {
    const proc = browser.process();
    try {
        await withTimeout(browser.close(), CLOSE_TIMEOUT);
    } catch (err: unknown) {
        debug(`${name}: close failed (${err instanceof Error ? err.message : err}) — killing`);
        try { proc?.kill('SIGKILL'); } catch { /* already gone */ }
    }
};
