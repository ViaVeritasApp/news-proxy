import {AxiosProxyConfig} from "axios";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

export type Proxy = AxiosProxyConfig & { id: string };

// Where the upstream pool is read from. May be a single file or a directory; a
// directory has every regular file in it concatenated, which is how a pool too
// large for one Kubernetes Secret is delivered. See README, "Proxy pool".
const POOL_PATH = process.env.PROXIES_FILE ?? './proxies_default.txt';

// Rejection-sampling budget in get(). `exclude` holds at most a handful of ids,
// so a random pick is almost always acceptable on the first try.
const SAMPLE_ATTEMPTS = 8;

const GZIP_MAGIC = [0x1f, 0x8b];

export class Proxies {
    private static readonly proxies: Record<string, Proxy[]> = {
        'default': [],
    };
    private static readonly lastUsed: Record<string, Proxy> = {};
    private static byId: Record<string, Proxy> = {};
    private static loaded = false;

    public static load() {
        for(const key in this.proxies) this.proxies[key] = [];
        this.byId = {};

        let text: string;
        try {
            text = this.read(POOL_PATH);
        } catch (err: unknown) {
            // No proxy file (or unreadable) -> leave the pool empty. Loud, because
            // a silently empty pool looks identical to a working one until every
            // Cloudflare-protected source starts failing.
            console.log(`Proxy pool: cannot read ${POOL_PATH} (${err instanceof Error ? err.message : err}) — running with no upstream proxies`);
            this.loaded = true;
            return;
        }

        let skipped = 0;
        let duplicates = 0;

        for (const p of text.split('\n')) {
            const line = p.trim();
            if (line.length === 0 || line.startsWith('#')) continue;

            const [host, port, username, password] = line.split(':');
            const portNum = parseInt(port, 10);

            // One malformed line in a 50k pool used to become a proxy with a NaN
            // port that fails every request it is handed. Drop it instead.
            if (!host || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
                skipped++;
                continue;
            }

            const id = crypto.createHash('sha1')
                .update(`${host}:${portNum}:${username ?? ''}`)
                .digest('hex')
                .slice(0, 8);

            // Concatenated files can repeat an entry; a duplicate would otherwise
            // sit in the rotation twice and be picked twice as often.
            if (this.byId[id]) {
                duplicates++;
                continue;
            }

            const proxy: Proxy = {
                id,
                host: host,
                port: portNum,
                ...(username && {
                    auth: {username, password},
                }),
                protocol: 'http'
            };

            this.proxies['default'].push(proxy);
            this.byId[id] = proxy;
        }

        const notes = [
            skipped ? `${skipped} malformed` : null,
            duplicates ? `${duplicates} duplicate` : null,
        ].filter(Boolean).join(', ');
        console.log(`Proxy pool: ${this.proxies['default'].length} proxies from ${POOL_PATH}${notes ? ` (${notes} skipped)` : ''}`);

        this.loaded = true;
    }

    /**
     * Reads the pool as text. `p` may be a file or a directory of files.
     */
    private static read(p: string): string {
        if (!fs.statSync(p).isDirectory()) return this.decode(fs.readFileSync(p));

        // A Secret projected as a directory also contains `..data` and other
        // dot-prefixed symlinks Kubernetes uses to swap contents atomically.
        // Reading those would duplicate the whole pool.
        const parts: string[] = [];
        for (const name of fs.readdirSync(p).sort()) {
            if (name.startsWith('.')) continue;
            const full = path.join(p, name);
            if (!fs.statSync(full).isFile()) continue;
            parts.push(this.decode(fs.readFileSync(full)));
        }
        return parts.join('\n');
    }

    /**
     * Accepts the pool as plain text, gzip, or base64-wrapped gzip, deciding from
     * the content rather than the filename — the filename is fixed by whatever
     * mounts it. Compression matters because the delivery path has a hard 1 MiB
     * ceiling; base64 is what lets the gzip survive a JSON secret store.
     *
     * Self-checking: a decode is only accepted when it yields the gzip magic, so
     * text that merely looks like base64 falls through to being treated as text.
     */
    private static decode(buf: Buffer): string {
        if (buf.length >= 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1]) {
            return zlib.gunzipSync(buf).toString('utf8');
        }

        // Every proxy line contains ':', which is not in the base64 alphabet, so
        // its absence is a reliable signal that this is not a plain pool.
        const head = buf.subarray(0, 4096).toString('utf8');
        if (head.length > 0 && !head.includes(':') && /^[A-Za-z0-9+/=\s]+$/.test(head)) {
            try {
                const inner = Buffer.from(buf.toString('utf8'), 'base64');
                if (inner.length >= 2 && inner[0] === GZIP_MAGIC[0] && inner[1] === GZIP_MAGIC[1]) {
                    return zlib.gunzipSync(inner).toString('utf8');
                }
            } catch { /* not base64 after all - fall through to plain text */ }
        }

        return buf.toString('utf8');
    }

    public static getById(id: string): Proxy | undefined {
        if (!this.loaded) this.load();
        return this.byId[id];
    }

    public static size(key: string = 'default'): number {
        if (!this.loaded) this.load();
        return (this.proxies[key] ?? this.proxies['default']).length;
    }

    public static get(url: string, key: string = 'default', exclude?: Set<string>): Proxy | undefined {
        if (!this.loaded) this.load();

        const proxies = this.proxies[key] ?? this.proxies['default'];
        if (proxies.length === 0) return undefined;

        const hostname = new URL(url).hostname;
        const last = this.lastUsed[hostname];
        const excluded = (p: Proxy) => exclude?.has(p.id) ?? false;

        // Rejection sampling rather than filtering the pool: the old code built a
        // filtered copy of the whole array on every retry, which at 50k entries
        // was by far the largest allocation on the request path.
        let cp: Proxy | undefined;
        for (let i = 0; i < SAMPLE_ATTEMPTS; i++) {
            const c = this.random(proxies);
            if (!excluded(c) && c !== last) {
                cp = c;
                break;
            }
        }

        // Sampling missed - either the pool is tiny or nearly everything is
        // excluded. Scan, preferring not to reuse `last`, but returning it rather
        // than nothing when it is the only proxy left untried.
        if (!cp) cp = proxies.find(p => !excluded(p) && p !== last) ?? proxies.find(p => !excluded(p));
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
