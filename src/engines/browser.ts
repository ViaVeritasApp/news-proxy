import { isChallenge, isHardBlock } from '../cloudflare.js';
import { debug } from '../log.js';
import { Proxy } from '../proxies.js';
import { BrowserEngine, FetchOutcome, FetchRequest, RequestEngine } from './types.js';
import { applyHeaders } from './headers.js';
import { environment } from '../environment.js';

// Wraps a page-based engine as a RequestEngine. The challenge handling lives here
// because clearing an interstitial needs the live page.
export const asRequestEngine = (engine: BrowserEngine): RequestEngine => ({
    name: engine.name,
    init: engine.init?.bind(engine),

    async fetch(req: FetchRequest, proxy: Proxy | undefined): Promise<FetchOutcome> {
        let dispose: () => Promise<void> = async () => {};

        try {
            const acquired = await engine.acquire(proxy, req.headers['User-Agent']);
            const page = acquired.page;
            dispose = acquired.dispose;

            const dropped = await applyHeaders(page, req.headers);
            if (dropped.length) debug(`${engine.name}: Chrome manages these, not sent — ${dropped.join(', ')}`);

            const navResponse = await page.goto(req.url, { waitUntil: req.waitUntil, timeout: environment.NAV_TIMEOUT });

            let status = navResponse?.status() ?? 200;
            const contentType = navResponse?.headers()['content-type'];
            let body = '';
            try {
                body = navResponse ? await navResponse.text() : await page.content();
            } catch {
                body = await page.content();
            }

            if (isHardBlock(body)) {
                // Terminal Cloudflare ban — no point waiting, rotate to another IP.
                debug(`${engine.name}: hard block (Cloudflare IP ban) — failing fast`);
                return { status, body, contentType, blocked: true };
            }

            if (isChallenge(body)) {
                debug(`${engine.name}: challenge detected, waiting up to ${req.responseTimeout}ms`);
                try {
                    await page.waitForFunction(
                        () => !/just a moment|checking your browser|attention required|verifying you are human/i
                                .test(document.title || ''),
                        { timeout: req.responseTimeout, polling: 500 },
                    );
                    await page.waitForNetworkIdle({ idleTime: 500, timeout: req.responseTimeout }).catch(() => {});
                } catch { /* still challenged after the wait budget */ }

                body = await page.content();
                if (isHardBlock(body) || isChallenge(body)) {
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
            await dispose();
        }
    },
});
