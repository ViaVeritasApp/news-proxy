import { HTTPResponse, Page } from 'puppeteer';
import { CHALLENGE_TITLE, isChallenge, isHardBlock } from '../cloudflare.js';
import { debug } from '../log.js';
import { Proxy } from '../proxies.js';
import { BrowserEngine, FetchOutcome, FetchRequest, RequestEngine } from './types.js';
import { applyHeaders } from './headers.js';
import { environment } from '../environment.js';

// Runs at most `limit` calls at once and queues the rest, FIFO. 0 disables it.
const createGate = (limit: number) => {
    if (limit <= 0) return <T>(fn: () => Promise<T>) => fn();

    let active = 0;
    const waiting: (() => void)[] = [];
    const release = () => {
        const next = waiting.shift();
        // A waiter inherits the slot, so `active` only drops when nobody wants it.
        if (next) next();
        else active--;
    };

    return async <T>(fn: () => Promise<T>): Promise<T> => {
        if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve));
        else active++;
        try {
            return await fn();
        } finally {
            release();
        }
    };
};

// Every in-flight browser request holds a Chrome, and Chrome is what the memory limit is
// spent on. Unbounded by default; a cap queues the surplus instead of launching it.
const gate = createGate(environment.BROWSER_CONCURRENCY);

// Wraps a page-based engine as a RequestEngine. The challenge handling lives here
// because clearing an interstitial needs the live page.
export const asRequestEngine = (engine: BrowserEngine): RequestEngine => ({
    name: engine.name,
    init: engine.init?.bind(engine),

    fetch(req: FetchRequest, proxy: Proxy | undefined): Promise<FetchOutcome> {
        return gate(() => browserFetch(engine, req, proxy));
    },
});

// HTML takes the rendered DOM; response.text() is the pre-script body. Feeds stay raw,
// since page.content() would wrap them in Chrome's XML viewer.
const readBody = async (page: Page, response: HTTPResponse | null): Promise<string> => {
    const contentType = response?.headers()['content-type'];
    if (!response || !contentType || /html|xml\+xhtml/i.test(contentType)) return page.content();
    return response.text().catch(() => page.content());
};

const browserFetch = async (
    engine: BrowserEngine,
    req: FetchRequest,
    proxy: Proxy | undefined,
): Promise<FetchOutcome> => {
    let dispose: () => Promise<void> = async () => {};

    try {
        const acquired = await engine.acquire(proxy, req.headers['User-Agent']);
        const page = acquired.page;
        dispose = acquired.dispose;

        const dropped = await applyHeaders(page, req.headers);
        if (dropped.length) debug(`${engine.name}: Chrome manages these, not sent — ${dropped.join(', ')}`);

        // A cleared challenge navigates again, and that document is the one to return.
        let lastNav: HTTPResponse | null = null;
        page.on('response', r => {
            if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) lastNav = r;
        });

        const navResponse = await page.goto(req.url, { waitUntil: req.waitUntil, timeout: environment.NAV_TIMEOUT });

        let status = navResponse?.status() ?? 200;
        let contentType = navResponse?.headers()['content-type'];
        let body = await readBody(page, navResponse);

        if (isHardBlock(body)) {
            // Terminal Cloudflare ban — no point waiting, rotate to another IP.
            debug(`${engine.name}: hard block (Cloudflare IP ban) — failing fast`);
            return { status, body, contentType, blocked: true };
        }

        if (isChallenge(body)) {
            debug(`${engine.name}: challenge detected, waiting up to ${req.responseTimeout}ms`);
            try {
                await page.waitForFunction(
                    (pattern: string) => !new RegExp(pattern, 'i').test(document.title || ''),
                    { timeout: req.responseTimeout, polling: 500 },
                    CHALLENGE_TITLE.source,
                );
                await page.waitForNetworkIdle({ idleTime: 500, timeout: req.responseTimeout }).catch(() => {});
            } catch { /* still challenged after the wait budget */ }

            const cleared: HTTPResponse | null = lastNav ?? navResponse;
            contentType = cleared?.headers()['content-type'];
            body = await readBody(page, cleared);
            if (isHardBlock(body) || CHALLENGE_TITLE.test(await page.title())) {
                debug(`${engine.name}: challenge NOT cleared`);
                return { status: 503, body, contentType, blocked: true };
            }

            debug(`${engine.name}: challenge cleared`);
            status = 200;
        }

        return { status, body, contentType, blocked: false };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        debug(`${engine.name}: error — ${message}`);
        return { status: 503, body: message, blocked: true };
    } finally {
        // A failed dispose must not replace the outcome, but it must be visible: what it
        // leaves behind is a live browser.
        await dispose().catch((err: unknown) =>
            debug(`${engine.name}: dispose failed — ${err instanceof Error ? err.message : err}`));
    }
};
