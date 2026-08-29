import { Page } from 'puppeteer';

/**
 * Headers Chrome owns. Setting them through CDP is either ignored or actively harmful:
 * the connection-level ones are managed by the network stack, and the Sec-Fetch/Sec-CH
 * family is computed per navigation - a hand-written value contradicts the rest of the
 * request and is a stronger bot signal than sending nothing.
 */
const BROWSER_MANAGED = new Set([
    'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade',
    'host', 'content-length', 'te', 'trailer',
    'accept-encoding',
]);

const isSecHeader = (name: string) => name.startsWith('sec-fetch-') || name.startsWith('sec-ch-');

/**
 * Applies caller headers to a page using the right mechanism for each.
 *
 * User-Agent and Accept-Language go through dedicated APIs rather than raw headers,
 * because both have a JS-visible counterpart (`navigator.userAgent`, `navigator.languages`)
 * that stays at the default otherwise - a mismatch trivially detectable from the page.
 */
export const applyHeaders = async (page: Page, headers: Record<string, string>): Promise<string[]> => {
    const extra: Record<string, string> = {};
    const dropped: string[] = [];
    let userAgent: string | undefined;
    let acceptLanguage: string | undefined;

    for (const [name, value] of Object.entries(headers)) {
        const key = name.toLowerCase();

        if (key === 'user-agent') userAgent = value;
        else if (key === 'accept-language') acceptLanguage = value;
        else if (BROWSER_MANAGED.has(key) || isSecHeader(key)) dropped.push(name);
        else extra[name] = value;
    }

    // setUserAgent also updates navigator.userAgent and the UA client hints.
    if (userAgent) await page.setUserAgent(userAgent);

    if (acceptLanguage) {
        extra['Accept-Language'] = acceptLanguage;
        const languages = acceptLanguage
            .split(',')
            .map(part => part.split(';')[0].trim())
            .filter(Boolean);

        if (languages.length) {
            await page.evaluateOnNewDocument((langs: string[]) => {
                Object.defineProperty(navigator, 'languages', { get: () => langs });
                Object.defineProperty(navigator, 'language', { get: () => langs[0] });
            }, languages);
        }
    }

    if (Object.keys(extra).length) await page.setExtraHTTPHeaders(extra);

    return dropped;
};
