import { BrowserEngine, Engine } from './types.js';
import { puppeteerEngine } from './puppeteer.js';
import { cloakEngine } from './cloak.js';

export { Engine, AcquiredPage, BrowserEngine } from './types.js';

export const ENGINES: Record<Engine, BrowserEngine> = {
    puppeteer: puppeteerEngine,
    cloak: cloakEngine,
};

// Run each engine's one-time startup (cloak is lazy and has none).
export const initEngines = async (): Promise<void> => {
    for (const engine of Object.values(ENGINES)) {
        if (engine.init) await engine.init();
    }
};
