import express, { Request, Response } from 'express';
import { Proxies, Proxy } from './proxies.js';
import { debug, DEBUG } from './log.js';
import { isChallenge, isHardBlock } from './cloudflare.js';
import { parseConfig, DEFAULT_ENGINE } from './config.js';
import { ENGINES, initEngines } from './engines/index.js';

const PORT = 3000;
const NAV_TIMEOUT = 30_000;

const app = express();

app.get('/*', async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    // Releases whatever the current attempt created (a context, a page, or a whole browser).
    let dispose: () => Promise<void> = async () => {};

    try {
        const url = req.originalUrl.startsWith('/')
            ? req.originalUrl.substring(1)
            : req.originalUrl;

        console.log(`Proxying ${url}`);

        const cfg = parseConfig(req);
        res.setHeader('X-Browser-Engine', cfg.engine);
        debug(`Config: engine=${cfg.engine}, useProxy=${cfg.useProxy}, requestedId=${cfg.requestedId ?? '-'}, group=${cfg.group}, timeout=${cfg.responseTimeout}ms, maxRetries=${cfg.maxRetries}, waitUntil=${cfg.waitUntil}`);

        // Validate a pinned proxy id up front.
        if (cfg.useProxy && cfg.requestedId && !Proxies.getById(cfg.requestedId)) {
            debug(`Unknown proxy id '${cfg.requestedId}' -> 400`);
            res.status(400).send('invalid-proxy-id');
            return;
        }

        const engine = ENGINES[cfg.engine];
        const triedIds = new Set<string>();
        let usedProxy: Proxy | undefined;
        let attempts = 0;
        let finalStatus = 503;
        let finalBody = 'no-proxy-available';

        for (let attempt = 1; attempt <= cfg.totalAttempts; attempt++) {
            // Pick a proxy for this attempt (excluding ones already tried).
            let proxy: Proxy | undefined;
            if (cfg.useProxy) {
                if (cfg.requestedId) {
                    proxy = Proxies.getById(cfg.requestedId);
                } else {
                    proxy = Proxies.get(url, cfg.group, triedIds);
                    if (!proxy && attempt > 1) {
                        debug(`No more untried proxies — stopping after ${attempt - 1} attempt(s)`);
                        break;
                    }
                    // attempt 1 with no proxy => empty pool => fall through to a direct connection.
                }
            }
            if (proxy) triedIds.add(proxy.id);
            usedProxy = proxy;
            attempts = attempt;

            const where = proxy
                ? `proxy ${proxy.id} (${proxy.host}:${proxy.port}${proxy.auth ? ', auth' : ''})`
                : 'direct connection';
            debug(`Attempt ${attempt}/${cfg.totalAttempts} [${cfg.engine}] ${where}`);

            let outcome: 'success' | 'blocked' = 'blocked';
            try {
                const acquired = await engine.acquire(proxy, req.header('User-Agent'));
                const page = acquired.page;
                dispose = acquired.dispose;

                const navResponse = await page.goto(url, { waitUntil: cfg.waitUntil, timeout: NAV_TIMEOUT });

                let status = navResponse?.status() ?? 200;
                let body = '';
                try {
                    body = navResponse ? await navResponse.text() : await page.content();
                } catch {
                    body = await page.content();
                }

                debug(`Attempt ${attempt}: status=${status}, bytes=${body.length}, ${Date.now() - startedAt}ms`);

                if (isHardBlock(body)) {
                    // Terminal Cloudflare ban — no point waiting, rotate to another IP.
                    debug(`Attempt ${attempt}: hard block (Cloudflare IP ban) — failing fast`);
                    outcome = 'blocked';
                } else if (isChallenge(body)) {
                    debug(`Attempt ${attempt}: challenge detected, waiting up to ${cfg.responseTimeout}ms`);
                    try {
                        await page.waitForFunction(
                            () => !/just a moment|checking your browser|attention required|verifying you are human/i
                                    .test(document.title || ''),
                            { timeout: cfg.responseTimeout, polling: 500 },
                        );
                        await page.waitForNetworkIdle({ idleTime: 500, timeout: cfg.responseTimeout }).catch(() => {});
                    } catch { /* still challenged after the wait budget */ }

                    body = await page.content();
                    if (isHardBlock(body) || isChallenge(body)) {
                        status = 503;
                        outcome = 'blocked';
                        debug(`Attempt ${attempt}: challenge NOT cleared`);
                    } else {
                        status = 200;
                        outcome = 'success';
                        debug(`Attempt ${attempt}: challenge cleared`);
                    }
                } else {
                    outcome = 'success';
                    debug(`Attempt ${attempt}: success`);
                }

                finalStatus = status;
                finalBody = body;
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : 'Unknown error';
                debug(`Attempt ${attempt}: error — ${message}`);
                finalStatus = 503;
                finalBody = message;
                outcome = 'blocked';
            } finally {
                await dispose();
                dispose = async () => {};
            }

            if (outcome === 'success') break;
            if (!cfg.rotating) break;                       // pinned id / direct: don't rotate
            if (attempt >= cfg.totalAttempts) break;
            debug(`Attempt ${attempt} blocked — retrying with a different proxy`);
        }

        res.setHeader('X-Proxy-Used', usedProxy ? 'true' : 'false');
        if (usedProxy) res.setHeader('X-Proxy-ID', usedProxy.id);
        res.setHeader('X-Proxy-Attempts', String(attempts));

        console.log(`Done ${url} -> ${finalStatus} (${finalBody.length} bytes, ${attempts} attempt(s) via ${cfg.engine}, ${Date.now() - startedAt}ms)`);
        res.status(finalStatus).send(finalBody);

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.log('Unexpected error', message);
        debug(`Failed after ${Date.now() - startedAt}ms`, error instanceof Error ? error.stack : error);
        res.status(503).send(message);
        await dispose();
    }
});

// Load the pool before the port opens rather than lazily on the first request:
// a large pool takes a moment to parse, and this puts the count in the startup
// log, where an empty pool is obvious — otherwise it only shows up later as
// requests that mysteriously go out unproxied.
Proxies.load();

initEngines()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Local proxy listening on port ${PORT} (default engine: ${DEFAULT_ENGINE}, ${Proxies.size()} proxies)`);
            debug(`Engines ready (debug=${DEBUG})`);
        });
    })
    .catch(console.error);
