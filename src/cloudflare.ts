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

// Cleared pages keep Cloudflare's `_cf_chl_opt` script, so once a challenge has been
// waited out only the title says whether it is still up.
export const CHALLENGE_TITLE = /just a moment|checking your browser|attention required|verifying you are human/i;

export const isHardBlock = (html: string): boolean => BLOCK_MARKERS.some(m => html.includes(m));
export const isChallenge = (html: string): boolean => CHALLENGE_MARKERS.some(m => html.includes(m));
