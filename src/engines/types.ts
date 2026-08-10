import { Page } from 'puppeteer';
import { Proxy } from '../proxies.js';

// Browser engine: 'puppeteer' (shared headless Chrome) or 'cloak' (stealth Chromium, launched per request).
export type Engine = 'puppeteer' | 'cloak';

// A ready-to-use page plus a function that releases whatever was created to produce it
// (a browser context, a single page, or a whole browser — engine-dependent).
export interface AcquiredPage {
    page: Page;
    dispose: () => Promise<void>;
}

export interface BrowserEngine {
    readonly name: Engine;
    // Optional one-time startup (e.g. launch a shared browser). Engines without it are lazy.
    init?(): Promise<void>;
    // Open a page routed through the given proxy (or direct when undefined).
    acquire(proxy: Proxy | undefined, userAgent?: string): Promise<AcquiredPage>;
}
