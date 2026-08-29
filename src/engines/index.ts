import { Engine, RequestEngine } from './types.js';
import { puppeteerEngine } from './puppeteer.js';
import { cloakEngine } from './cloak.js';
import { axiosEngine } from './axios.js';
import { asRequestEngine } from './browser.js';

export { Engine, AcquiredPage, BrowserEngine, RequestEngine, FetchRequest, FetchOutcome, WaitUntil } from './types.js';

export const ENGINES: Record<Engine, RequestEngine> = {
    axios: axiosEngine,
    puppeteer: asRequestEngine(puppeteerEngine),
    cloak: asRequestEngine(cloakEngine),
};

// Per-engine failures are non-fatal: puppeteer losing its Chrome must not take down
// the axios engine that serves almost every request.
export const initEngines = async (): Promise<void> => {
    for (const engine of Object.values(ENGINES)) {
        if (!engine.init) continue;
        try {
            await engine.init();
        } catch (err: unknown) {
            console.log(`Engine ${engine.name} failed to start:`, err instanceof Error ? err.message : err);
        }
    }
};
