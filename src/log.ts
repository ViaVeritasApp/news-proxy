// Shared debug logger. Enabled when the DEBUG env var is 1/true/yes/on.
export const DEBUG = /^(1|true|yes|on)$/i.test(process.env.DEBUG ?? '');

export const debug = (...args: unknown[]): void => {
    if (DEBUG) console.log('[debug]', ...args);
};
