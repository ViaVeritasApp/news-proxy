import {bool, cleanEnv, num, port, str} from 'envalid';

export const environment = cleanEnv(process.env, {
    PORT: port({default: 3000}),

    // Engine used when a request does not name one. `axios` is a plain forward.
    BROWSER_ENGINE: str({choices: ['axios', 'puppeteer', 'cloak'], default: 'axios'}),

    DEBUG: bool({default: false}),

    // How long a browser engine waits for a challenge to clear.
    RESPONSE_TIMEOUT: num({default: 5000}),
    // Upper bound on X-Proxy-Max-Retries.
    MAX_RETRIES_CAP: num({default: 3}),
    // Per-attempt navigation/request timeout.
    NAV_TIMEOUT: num({default: 30_000}),

    // Concurrent browser-engine requests, each holding its own Chrome. 0 is unbounded,
    // which lets a burst of callers launch more Chromes than the memory limit fits.
    BROWSER_CONCURRENCY: num({default: 0}),
    MAX_BODY_BYTES: num({default: 256 * 1024 * 1024}),

    // Sent upstream unless a request overrides them with X-C-<Header>.
    FORWARD_USER_AGENT: str({default: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0'}),
    FORWARD_ACCEPT: str({default: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'}),
    FORWARD_ACCEPT_LANGUAGE: str({default: 'en-US,en;q=0.5'}),
});

export const FORWARD_HEADERS: Record<string, string> = {
    'User-Agent': environment.FORWARD_USER_AGENT,
    'Accept': environment.FORWARD_ACCEPT,
    'Accept-Language': environment.FORWARD_ACCEPT_LANGUAGE,
    'Connection': 'keep-alive',
};

// Per-country pools: one PROXIES_<CC> per country, so they cannot be declared statically.
// Value is the pool inline or a path to one.
export const countryPoolVars = (): {country: string; value: string}[] =>
    Object.entries(process.env)
        .map(([key, value]) => ({match: /^PROXIES_([A-Za-z]{2})$/.exec(key), value}))
        .filter((e): e is {match: RegExpExecArray; value: string} => Boolean(e.match && e.value?.trim()))
        .map(e => ({country: e.match[1].toLowerCase(), value: e.value}));
