import express, { Request, Response } from 'express';
import { Proxies, Proxy } from './proxies.js';
import { debug, DEBUG } from './log.js';
import { parseConfig, DEFAULT_ENGINE } from './config.js';
import { ENGINES, initEngines } from './engines/index.js';
import { environment } from './environment.js';

const PORT = environment.PORT;

const app = express();

app.get('/*', async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();

    try {
        const url = req.originalUrl.startsWith('/')
            ? req.originalUrl.substring(1)
            : req.originalUrl;

        console.log(`Proxying ${url}`);

        const cfg = parseConfig(req);
        res.setHeader('X-Browser-Engine', cfg.engine);
        debug(`Config: engine=${cfg.engine}, useProxy=${cfg.useProxy}, requestedId=${cfg.requestedId ?? '-'}, country=${cfg.country ?? 'any'}, timeout=${cfg.responseTimeout}ms, maxRetries=${cfg.maxRetries}, waitUntil=${cfg.waitUntil}`);

        // Validate a pinned proxy id up front.
        if (cfg.useProxy && cfg.requestedId && !Proxies.getById(cfg.requestedId)) {
            debug(`Unknown proxy id '${cfg.requestedId}' -> 400`);
            res.status(400).send('invalid-proxy-id');
            return;
        }

        // A country with no pool is not an error — the request still has to go out, it
        // just goes out from wherever. Resolved once so the response header reports what
        // was actually used rather than what was asked for.
        const country = cfg.country && Proxies.has(cfg.country) ? cfg.country : undefined;
        if (cfg.country && !country) {
            debug(`No pool for country '${cfg.country}' — falling back to the default pool`);
        }

        const engine = ENGINES[cfg.engine];
        const triedIds = new Set<string>();
        let usedProxy: Proxy | undefined;
        let attempts = 0;
        let finalStatus = 503;
        let finalBody = 'no-proxy-available';
        let finalContentType: string | undefined;

        for (let attempt = 1; attempt <= cfg.totalAttempts; attempt++) {
            // Pick a proxy for this attempt (excluding ones already tried).
            let proxy: Proxy | undefined;
            if (cfg.useProxy) {
                if (cfg.requestedId) {
                    proxy = Proxies.getById(cfg.requestedId);
                } else {
                    proxy = Proxies.get(url, country, triedIds);
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

            const outcome = await engine.fetch({
                url,
                headers: cfg.headers,
                waitUntil: cfg.waitUntil,
                responseTimeout: cfg.responseTimeout,
            }, proxy);

            finalStatus = outcome.status;
            finalBody = outcome.body;
            finalContentType = outcome.contentType;

            debug(`Attempt ${attempt}: status=${outcome.status}, bytes=${outcome.body.length}, blocked=${outcome.blocked}, ${Date.now() - startedAt}ms`);

            if (!outcome.blocked) break;
            if (!cfg.rotating) break;                       // pinned id / direct: don't rotate
            if (attempt >= cfg.totalAttempts) break;
            debug(`Attempt ${attempt} blocked — retrying with a different proxy`);
        }

        res.setHeader('X-Proxy-Used', usedProxy ? 'true' : 'false');
        if (usedProxy) res.setHeader('X-Proxy-ID', usedProxy.id);
        if (country) res.setHeader('X-Proxy-Country', country);
        res.setHeader('X-Proxy-Attempts', String(attempts));

        // Pass the target's content-type through, else express stamps text/html and axios
        // callers get a string. Malformed values (`xml;charset=UTF-8`) crash send().
        if (finalContentType && isMediaType(finalContentType)) {
            res.setHeader('Content-Type', finalContentType);
        } else if (finalContentType) {
            debug(`Dropping malformed content-type '${finalContentType}'`);
        }

        console.log(`Done ${url} -> ${finalStatus} (${finalBody.length} bytes, ${attempts} attempt(s) via ${cfg.engine}, ${Date.now() - startedAt}ms)`);
        res.status(finalStatus).send(finalBody);

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.log('Unexpected error', message);
        debug(`Failed after ${Date.now() - startedAt}ms`, error instanceof Error ? error.stack : error);

        // Must not throw again: a bad header left on the response would reject this async
        // handler, which express 4 does not catch.
        try {
            if (!res.headersSent) {
                res.removeHeader('Content-Type');
                res.status(503).send(message);
            } else {
                res.end();
            }
        } catch {
            res.destroy();
        }
    }
});

// `type/subtype` with optional parameters; anything else breaks express on the way out.
const isMediaType = (value: string): boolean =>
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*(;|$)/.test(value.trim());

// One bad response must not exit the process and take every scrape down with it.
process.on('unhandledRejection', (reason: unknown) => {
    console.log('Unhandled rejection', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (error: Error) => {
    console.log('Uncaught exception', error.stack ?? error.message);
});

Proxies.load();

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Local proxy listening on 0.0.0.0:${PORT} (default engine: ${DEFAULT_ENGINE}, ${Proxies.size()} proxies${Proxies.countries().length ? `, countries: ${Proxies.countries().join(', ')}` : ''})`);
});

initEngines()
    .then(() => debug(`Engines ready (debug=${DEBUG})`))
    .catch((err: unknown) => {
        console.log('Engine warm-up failed, continuing without it:',
            err instanceof Error ? err.message : err);
    });
