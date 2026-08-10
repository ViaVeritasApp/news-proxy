// Cloudflare response classification.

// Terminal block (IP/WAF ban, error 1020) — nothing to solve, retry a different IP.
const BLOCK_MARKERS = [
    'you have been blocked',
    'Attention Required! | Cloudflare',
    'cf-error-details',
    'error code: 1020',
    'cdn-cgi/styles/cf.errors.css',
];

// Solvable interstitial (JS/managed challenge) — worth waiting for it to clear.
const CHALLENGE_MARKERS = [
    'Just a moment',
    'Checking your browser',
    'Verifying you are human',
    '_cf_chl_opt',
    'cf_chl_opt',
    'cf-turnstile',
    'challenge-running',
];

export const isHardBlock = (html: string): boolean => BLOCK_MARKERS.some(m => html.includes(m));
export const isChallenge = (html: string): boolean => CHALLENGE_MARKERS.some(m => html.includes(m));
