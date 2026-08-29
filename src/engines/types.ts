import { Page } from 'puppeteer';
import { Proxy } from '../proxies.js';

// How a request is issued:
//  - 'axios'     plain HTTP forward, no browser (the default)
//  - 'puppeteer' shared headless Chrome
//  - 'cloak'     stealth Chromium, launched per request
export type Engine = 'axios' | 'puppeteer' | 'cloak';

export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';

// What one attempt asks for. `waitUntil` and `responseTimeout` only mean something to
// the browser engines; the axios engine ignores them.
export interface FetchRequest {
    url: string;
    headers: Record<string, string>;
    waitUntil: WaitUntil;
    responseTimeout: number;
}

// `blocked` is the engine's verdict on whether to rotate to another proxy. Keeping it
// inside the engine lets the caller run one rotation loop for every engine.
export interface FetchOutcome {
    status: number;
    body: string;
    contentType?: string;
    blocked: boolean;
}

export interface RequestEngine {
    readonly name: Engine;
    // Optional one-time startup (e.g. launch a shared browser). Engines without it are lazy.
    init?(): Promise<void>;
    fetch(req: FetchRequest, proxy: Proxy | undefined): Promise<FetchOutcome>;
}

// ---------------------------------------------------------------------------
// Browser-engine plumbing. Only the two Chrome-based engines implement this;
// `browserFetch` in browser.ts turns one into a RequestEngine.
// ---------------------------------------------------------------------------

// A ready-to-use page plus a function that releases whatever was created to produce it
// (a browser context, a single page, or a whole browser — engine-dependent).
export interface AcquiredPage {
    page: Page;
    dispose: () => Promise<void>;
}

export interface BrowserEngine {
    readonly name: Engine;
    init?(): Promise<void>;
    // Open a page routed through the given proxy (or direct when undefined).
    acquire(proxy: Proxy | undefined, userAgent?: string): Promise<AcquiredPage>;
}
