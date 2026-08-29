import { environment } from './environment.js';

export const DEBUG = environment.DEBUG;

export const debug = (...args: unknown[]): void => {
    if (DEBUG) console.log('[debug]', ...args);
};
