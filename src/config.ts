import { Request } from 'express';
import { Engine } from './engines/index.js';

const RESPONSE_TIMEOUT = 5000;
const MAX_RETRIES_CAP = 3;
const ALLOWED_WAIT = ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'] as const;
type WaitUntil = typeof ALLOWED_WAIT[number];

const DEFAULT_ENGINE: Engine =
    (process.env.BROWSER_ENGINE ?? 'cloak').toLowerCase() === 'puppeteer' ? 'puppeteer' : 'cloak';

// Everything a request's control headers decide. These headers are consumed here and
// never forwarded to the target.
export interface RequestConfig {
    engine: Engine;
    useProxy: boolean;
    requestedId?: string;   // pin a specific proxy by id
    group: string;          // proxy pool to rotate within
    responseTimeout: number;
    maxRetries: number;
    totalAttempts: number;  // 1 + maxRetries
    waitUntil: WaitUntil;
    rotating: boolean;      // retry-rotate proxies (only when auto-selecting)
}

export const parseConfig = (req: Request): RequestConfig => {
    const useProxy = (req.header('X-Proxy-Use') ?? 'true').toLowerCase() !== 'false';
    const requestedId = req.header('X-Proxy-ID');
    const group = req.header('X-Proxy-Group') ?? 'default';

    const timeoutHeader = parseInt(req.header('X-Proxy-Timeout') ?? '', 10);
    const responseTimeout = Number.isFinite(timeoutHeader) && timeoutHeader > 0
        ? timeoutHeader : RESPONSE_TIMEOUT;

    const retriesHeader = parseInt(req.header('X-Proxy-Max-Retries') ?? '', 10);
    const maxRetries = Number.isFinite(retriesHeader)
        ? Math.min(Math.max(retriesHeader, 0), MAX_RETRIES_CAP) : 1;

    const waitHeader = req.header('X-Proxy-Wait-Until');
    const waitUntil: WaitUntil = (ALLOWED_WAIT as readonly string[]).includes(waitHeader ?? '')
        ? waitHeader as WaitUntil : 'load';

    const engineHeader = req.header('X-Browser-Engine')?.toLowerCase();
    const engine: Engine = engineHeader === 'puppeteer' || engineHeader === 'cloak'
        ? engineHeader : DEFAULT_ENGINE;

    return {
        engine,
        useProxy,
        requestedId,
        group,
        responseTimeout,
        maxRetries,
        totalAttempts: 1 + maxRetries,
        waitUntil,
        // Retry rotation only makes sense for auto-selected proxies.
        rotating: useProxy && !requestedId,
    };
};

export { DEFAULT_ENGINE };
