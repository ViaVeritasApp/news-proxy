import express, { Request, Response } from 'express';
import {Browser, BrowserContext, Page} from "puppeteer";
import puppeteer, {PuppeteerExtra} from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { URL } from 'url';
import { Proxies, Proxy } from './proxies.js';

const PORT = 3000;
const RESPONSE_TIMEOUT = 5000;

const app = express();
let browser: Browser;

const initializeBrowser = async (): Promise<void> => {
    browser = await (puppeteer as any as PuppeteerExtra)
        .use(StealthPlugin())
        .launch({
            executablePath: '/usr/bin/google-chrome',
            headless: 'shell',
            timeout: 60_000,
            args: [
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ]
        });

    app.listen(PORT, () => {
        console.log(`Local proxy listening on port ${PORT}`);
    });
};

const setupPage = async (page: Page, userAgent?: string): Promise<void> => {
    if (userAgent) {
        await page.setUserAgent(userAgent);
    }

    await page.setViewport({ width: 1080, height: 1024 });

    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => false,
        });
    });
};

const areUrlsSame = (url1: string, url2: string): boolean => {
    if (url1 === url2) return true;

    try {
        const parsedUrl1 = new URL(url1);
        const parsedUrl2 = new URL(url2);

        return parsedUrl1.protocol === parsedUrl2.protocol &&
            parsedUrl1.hostname === parsedUrl2.hostname &&
            parsedUrl1.pathname.replaceAll('/', '') === parsedUrl2.pathname.replaceAll('/', '') &&
            parsedUrl1.search === parsedUrl2.search &&
            parsedUrl1.hash === parsedUrl2.hash;
    } catch {
        return false;
    }
};

app.get('/*', async (req: Request, res: Response): Promise<void> => {
    let page: Page | null = null;
    let context: BrowserContext | null = null;

    const cleanup = async (): Promise<void> => {
        await page?.close();
        await context?.close();
    };

    try {
        let url = req.originalUrl.startsWith('/')
            ? req.originalUrl.substring(1)
            : req.originalUrl;

        console.log(`Proxying ${url}`);

        let responded = false;

        // Proxy control headers — consumed here, never forwarded to the target.
        const useProxy = (req.header('X-Proxy-Use') ?? 'true').toLowerCase() !== 'false';
        const requestedId = req.header('X-Proxy-ID');
        const group = req.header('X-Proxy-Group') ?? 'default';

        const timeoutHeader = parseInt(req.header('X-Proxy-Timeout') ?? '', 10);
        const responseTimeout = Number.isFinite(timeoutHeader) && timeoutHeader > 0
            ? timeoutHeader : RESPONSE_TIMEOUT;

        const ALLOWED_WAIT = ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'] as const;
        const waitHeader = req.header('X-Proxy-Wait-Until');
        const waitUntil = (ALLOWED_WAIT as readonly string[]).includes(waitHeader ?? '')
            ? waitHeader as typeof ALLOWED_WAIT[number] : 'load';

        let proxy: Proxy | undefined;
        if (useProxy) {
            if (requestedId) {
                proxy = Proxies.getById(requestedId);
                if (!proxy) {
                    res.status(400).send('invalid-proxy-id');
                    return;
                }
            } else {
                proxy = Proxies.get(url, group);
            }
        }

        res.setHeader('X-Proxy-Used', proxy ? 'true' : 'false');
        if (proxy) res.setHeader('X-Proxy-ID', proxy.id);

        if (proxy) {
            context = await browser.createBrowserContext({
                proxyServer: Proxies.toProxyServer(proxy),
            });
            page = await context.newPage();
            if (proxy.auth) await page.authenticate(proxy.auth);
        } else {
            // No proxies loaded -> direct connection.
            page = await browser.newPage();
        }

        await setupPage(page, req.header('User-Agent'));

        page.on('response', async (response) => {
            const respUrl = response.url();
            const respStatus = response.status();

            if (respStatus >= 300 && respStatus <= 399) return;
            if (!areUrlsSame(respUrl, url)) return;

            const content = await response.text();

            if (respStatus >= 400) {
                console.log(content);
            }

            responded = true;
            res.status(respStatus).send(content);
            await cleanup();
        });

        await page.goto(url, { waitUntil });

        setTimeout(async () => {
            if (!responded) {
                res.status(503).send('timeout-error');
                await cleanup();
            }
        }, responseTimeout);

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.log('Unexpected error', message);
        res.status(503).send(message);
        await cleanup();
    }
});

initializeBrowser().catch(console.error);
