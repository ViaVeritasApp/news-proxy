import { Request } from 'express';
import { Engine } from './engines/index.js';
import { environment, FORWARD_HEADERS } from './environment.js';

const ALLOWED_WAIT = ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'] as const;
type WaitUntil = typeof ALLOWED_WAIT[number];

const ENGINE_NAMES: readonly Engine[] = ['axios', 'puppeteer', 'cloak'];

// `axios` is the default: a plain forward with no browser, which is what almost every
// source needs. A browser engine is opt-in per request, for sites that answer a plain
// HTTP client with a challenge.
const DEFAULT_ENGINE: Engine = (ENGINE_NAMES as readonly string[]).includes(environment.BROWSER_ENGINE)
    ? environment.BROWSER_ENGINE as Engine : 'axios';

// Sent upstream unless the caller overrides them with X-C-<Header>.
export const DEFAULT_FORWARD_HEADERS = FORWARD_HEADERS;

// Everything a request's control headers decide. These headers are consumed here and
// never forwarded to the target.
export interface RequestConfig {
    engine: Engine;
    useProxy: boolean;
    requestedId?: string;   // pin a specific proxy by id
    country?: string;       // ISO 3166-1 alpha-2, lowercased; undefined => any
    responseTimeout: number;
    maxRetries: number;
    totalAttempts: number;  // 1 + maxRetries
    waitUntil: WaitUntil;
    rotating: boolean;      // retry-rotate proxies (only when auto-selecting)
    headers: Record<string, string>;  // what actually goes upstream
}

// X-C-<Header> overrides a default outright. Empty value removes the header.
const collectHeaders = (req: Request): Record<string, string> => {
    const headers: Record<string, string> = { ...DEFAULT_FORWARD_HEADERS };
    // Lower-cased default names, so an override lands on the default regardless of the
    // casing the caller used (`X-C-user-agent` must replace `User-Agent`, not add a second).
    const canonical = new Map(Object.keys(DEFAULT_FORWARD_HEADERS).map(k => [k.toLowerCase(), k]));

    for (const [name, value] of Object.entries(req.headers)) {
        if (!name.toLowerCase().startsWith('x-c-')) continue;

        const target = name.slice(4);
        if (!target) continue;

        const key = canonical.get(target.toLowerCase()) ?? target;
        const resolved = Array.isArray(value) ? value.join(', ') : value ?? '';

        if (resolved === '') delete headers[key];
        else headers[key] = resolved;
    }

    return headers;
};

export const parseConfig = (req: Request): RequestConfig => {
    const useProxy = (req.header('X-Proxy-Use') ?? 'true').toLowerCase() !== 'false';
    const requestedId = req.header('X-Proxy-ID');

    // Two letters only. Anything else is treated as "no preference" rather than an error,
    // because a bad code should degrade to a working request, not fail one.
    const countryHeader = req.header('X-Proxy-Country')?.trim().toLowerCase();
    const country = countryHeader && /^[a-z]{2}$/.test(countryHeader) ? countryHeader : undefined;

    const timeoutHeader = parseInt(req.header('X-Proxy-Timeout') ?? '', 10);
    const responseTimeout = Number.isFinite(timeoutHeader) && timeoutHeader > 0
        ? timeoutHeader : environment.RESPONSE_TIMEOUT;

    const retriesHeader = parseInt(req.header('X-Proxy-Max-Retries') ?? '', 10);
    const maxRetries = Number.isFinite(retriesHeader)
        ? Math.min(Math.max(retriesHeader, 0), environment.MAX_RETRIES_CAP) : 1;

    const waitHeader = req.header('X-Proxy-Wait-Until');
    const waitUntil: WaitUntil = (ALLOWED_WAIT as readonly string[]).includes(waitHeader ?? '')
        ? waitHeader as WaitUntil : 'load';

    const engineHeader = req.header('X-Browser-Engine')?.toLowerCase();
    const engine: Engine = (ENGINE_NAMES as readonly string[]).includes(engineHeader ?? '')
        ? engineHeader as Engine : DEFAULT_ENGINE;

    return {
        engine,
        useProxy,
        requestedId,
        country,
        responseTimeout,
        maxRetries,
        totalAttempts: 1 + maxRetries,
        waitUntil,
        // Retry rotation only makes sense for auto-selected proxies.
        rotating: useProxy && !requestedId,
        headers: collectHeaders(req),
    };
};

export { DEFAULT_ENGINE, ALLOWED_WAIT };
export type { WaitUntil };
