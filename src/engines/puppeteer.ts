import { Browser, Page } from 'puppeteer';
import puppeteer, { PuppeteerExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Proxies, Proxy } from '../proxies.js';
import { debug } from '../log.js';
import { AcquiredPage, BrowserEngine } from './types.js';

// One shared headless Chrome for the whole process; each request gets its own
// browser context (so per-request proxies stay isolated).
class PuppeteerEngine implements BrowserEngine {
    public readonly name = 'puppeteer' as const;
    private browser!: Browser;

    public async init(): Promise<void> {
        this.browser = await (puppeteer as any as PuppeteerExtra)
            .use(StealthPlugin())
            .launch({
                executablePath: '/usr/bin/google-chrome',
                headless: true,
                timeout: 60_000,
                args: [
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--lang=en-US',
                ],
            });
        debug('Puppeteer shared browser ready (headless=true)');
    }

    public async acquire(proxy: Proxy | undefined, userAgent?: string): Promise<AcquiredPage> {
        let page: Page;
        let dispose: () => Promise<void>;

        if (proxy) {
            const context = await this.browser.createBrowserContext({
                proxyServer: Proxies.toProxyServer(proxy),
            });
            dispose = async () => { await context.close(); };
            page = await context.newPage();
            if (proxy.auth) await page.authenticate(proxy.auth);
        } else {
            const newPage = await this.browser.newPage();
            dispose = async () => { await newPage.close(); };
            page = newPage;
        }

        await this.setupPage(page, userAgent);
        return { page, dispose };
    }

    private async setupPage(page: Page, userAgent?: string): Promise<void> {
        if (userAgent) await page.setUserAgent(userAgent);
        await page.setViewport({ width: 1080, height: 1024 });
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
    }
}

export const puppeteerEngine = new PuppeteerEngine();
