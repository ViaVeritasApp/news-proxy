import express, { Request, Response } from 'express';
import {Browser, Page} from "puppeteer";
import puppeteer, {PuppeteerExtra} from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { URL } from 'url';

const PORT = 3100;
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

    try {
        let url = req.originalUrl.startsWith('/')
            ? req.originalUrl.substring(1)
            : req.originalUrl;

        console.log(`Proxying ${url}`);

        let responded = false;
        page = await browser.newPage();

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
            await page?.close();
        });

        await page.goto(url, { waitUntil: 'load' });

        setTimeout(async () => {
            if (!responded) {
                res.status(503).send('timeout-error');
                await page?.close();
            }
        }, RESPONSE_TIMEOUT);

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.log('Unexpected error', message);
        res.status(503).send(message);
        await page?.close();
    }
});

initializeBrowser().catch(console.error);
