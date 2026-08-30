import { Page } from 'puppeteer';
import { launch as cloakLaunch } from 'cloakbrowser/puppeteer';
import { Proxies, Proxy } from '../proxies.js';
import { closeBrowser } from './lifecycle.js';
import { AcquiredPage, BrowserEngine } from './types.js';

// Stealth Chromium. Its proxy is fixed at launch (no per-context proxy), so we launch
// a fresh browser per request and close it afterwards. Runs headful (needs Xvfb in Docker).
class CloakEngine implements BrowserEngine {
    public readonly name = 'cloak' as const;

    public async acquire(proxy: Proxy | undefined, userAgent?: string): Promise<AcquiredPage> {
        const browser = await cloakLaunch({
            headless: false,
            humanize: true,
            ...(proxy && { proxy: Proxies.toProxyUrl(proxy) }),
        });

        try {
            // cloak returns a puppeteer-core Page; identical at runtime to puppeteer's Page.
            const page = await browser.newPage() as unknown as Page;
            await this.setupPage(page, userAgent);
            return { page, dispose: () => closeBrowser(browser, this.name) };
        } catch (err: unknown) {
            // The caller owns nothing until acquire returns, so a browser opened here is
            // closed here or it is leaked with no handle left to close it.
            await closeBrowser(browser, this.name);
            throw err;
        }
    }

    // Cloak handles anti-detection at the binary level, so we add no webdriver shim here
    // (a naive shim would only introduce a detectable inconsistency).
    private async setupPage(page: Page, userAgent?: string): Promise<void> {
        if (userAgent) await page.setUserAgent(userAgent);
        await page.setViewport({ width: 1080, height: 1024 });
    }
}

export const cloakEngine = new CloakEngine();
