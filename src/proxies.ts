import {AxiosProxyConfig} from "axios";
import crypto from "node:crypto";
import fs from "node:fs";
import {countryPoolVars} from "./environment.js";

export type Proxy = AxiosProxyConfig & { id: string };

// Rejection-sampling budget in get(). `exclude` holds at most a handful of ids,
// so a random pick is almost always acceptable on the first try.
const SAMPLE_ATTEMPTS = 8;

/**
 * The upstream pools, one per country, from the PROXIES_<CC> environment variables.
 *
 * There is no country-less pool: a request that asks for nothing, or for a country with
 * no pool, draws at random from every proxy loaded.
 */
export class Proxies {
    private static readonly proxies: Record<string, Proxy[]> = {};
    private static all: Proxy[] = [];
    private static readonly lastUsed: Record<string, Proxy> = {};
    private static byId: Record<string, Proxy> = {};
    private static loaded = false;

    public static load() {
        for (const key in this.proxies) delete this.proxies[key];
        this.byId = {};
        this.all = [];

        for (const {country, value} of countryPoolVars()) {
            let text = value;
            let origin = `$PROXIES_${country.toUpperCase()}`;

            // Every proxy line contains ':', so a value without one is a path, not a pool.
            if (!value.includes(':')) {
                origin = value.trim();
                try {
                    text = fs.readFileSync(origin, 'utf8');
                } catch (err: unknown) {
                    console.log(`Proxy pool ${country}: cannot read ${origin} (${err instanceof Error ? err.message : err}) — skipping`);
                    continue;
                }
            }

            this.parseInto(text.replace(/,/g, '\n'), country, origin);
        }

        this.all = Object.values(this.proxies).flat();
        // An empty pool is not an error, but it looks identical to a working one until
        // every geo-gated or protected source starts failing.
        if (this.all.length === 0) console.log('Proxy pool: empty — every request goes out directly');

        this.loaded = true;
    }

    // De-duplicates per pool, not globally: the same proxy may legitimately serve
    // more than one country.
    private static parseInto(text: string, country: string, origin: string) {
        const pool = (this.proxies[country] ??= []);
        const seen = new Set(pool.map(p => p.id));
        let skipped = 0;
        let duplicates = 0;

        for (const p of text.split('\n')) {
            const line = p.trim();
            if (line.length === 0 || line.startsWith('#')) continue;

            const [host, port, username, password] = line.split(':');
            const portNum = parseInt(port, 10);

            // One malformed line used to become a proxy with a NaN port that fails
            // every request it is handed. Drop it instead.
            if (!host || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
                skipped++;
                continue;
            }

            const id = crypto.createHash('sha1')
                .update(`${host}:${portNum}:${username ?? ''}`)
                .digest('hex')
                .slice(0, 8);

            if (seen.has(id)) {
                duplicates++;
                continue;
            }
            seen.add(id);

            const proxy: Proxy = {
                id,
                host: host,
                port: portNum,
                ...(username && {
                    auth: {username, password},
                }),
                protocol: 'http'
            };

            pool.push(proxy);
            this.byId[id] = proxy;
        }

        const notes = [
            skipped ? `${skipped} malformed` : null,
            duplicates ? `${duplicates} duplicate` : null,
        ].filter(Boolean).join(', ');
        console.log(`Proxy pool ${country}: ${pool.length} proxies from ${origin}${notes ? ` (${notes} skipped)` : ''}`);
    }

    public static getById(id: string): Proxy | undefined {
        if (!this.loaded) this.load();
        return this.byId[id];
    }

    public static size(country?: string): number {
        if (!this.loaded) this.load();
        return country ? (this.proxies[country.toLowerCase()]?.length ?? 0) : this.all.length;
    }

    // Whether a country has a pool of its own. An empty pool counts as absent.
    public static has(country: string): boolean {
        if (!this.loaded) this.load();
        return (this.proxies[country.toLowerCase()]?.length ?? 0) > 0;
    }

    public static countries(): string[] {
        if (!this.loaded) this.load();
        return Object.keys(this.proxies).filter(k => this.proxies[k].length > 0).sort();
    }

    // `country` undefined, or a country with no pool, draws from every proxy loaded.
    public static get(url: string, country?: string, exclude?: Set<string>): Proxy | undefined {
        if (!this.loaded) this.load();

        const pool = country ? (this.proxies[country.toLowerCase()] ?? this.all) : this.all;
        if (pool.length === 0) return undefined;

        const hostname = new URL(url).hostname;
        const last = this.lastUsed[hostname];
        const excluded = (p: Proxy) => exclude?.has(p.id) ?? false;

        // Rejection sampling rather than filtering the pool: filtering built a copy of
        // the whole array on every retry, by far the largest allocation on this path.
        let cp: Proxy | undefined;
        for (let i = 0; i < SAMPLE_ATTEMPTS; i++) {
            const c = this.random(pool);
            if (!excluded(c) && c !== last) {
                cp = c;
                break;
            }
        }

        // Sampling missed - the pool is tiny or nearly everything is excluded. Scan,
        // preferring not to reuse `last` but returning it rather than nothing when it is
        // the only proxy left untried.
        if (!cp) cp = pool.find(p => !excluded(p) && p !== last) ?? pool.find(p => !excluded(p));
        if (!cp) return undefined;

        this.lastUsed[hostname] = cp;
        return cp;
    }

    public static toProxyServer(p: Proxy): string {
        return `${p.protocol ?? 'http'}://${p.host}:${p.port}`;
    }

    // Full proxy URL with inline credentials (for engines that take the proxy at launch).
    public static toProxyUrl(p: Proxy): string {
        const protocol = p.protocol ?? 'http';
        if (p.auth) {
            const user = encodeURIComponent(p.auth.username);
            const pass = encodeURIComponent(p.auth.password);
            return `${protocol}://${user}:${pass}@${p.host}:${p.port}`;
        }
        return `${protocol}://${p.host}:${p.port}`;
    }

    private static random(list: Proxy[]): Proxy {
        return list[Math.floor(Math.random() * list.length)];
    }
}
