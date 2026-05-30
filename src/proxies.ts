import {AxiosProxyConfig} from "axios";
import fs from "node:fs";
import crypto from "node:crypto";

export type Proxy = AxiosProxyConfig & { id: string };

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

        let lines: string[];
        try {
            lines = fs.readFileSync('./proxies_default.txt', 'utf8').split('\n');
        } catch {
            // No proxy file (or unreadable) -> leave the pool empty.
            this.loaded = true;
            return;
        }

        for (const p of lines) {
            const line = p.trim();
            if (line.length === 0) continue;

            const [host, port, username, password] = line.split(':');

            const id = crypto.createHash('sha1')
                .update(`${host}:${port}:${username ?? ''}`)
                .digest('hex')
                .slice(0, 8);

            const proxy: Proxy = {
                id,
                host: host,
                port: parseInt(port, 10),
                ...(username && {
                    auth: {username, password},
                }),
                protocol: 'http'
            };

            this.proxies['default'].push(proxy);
            this.byId[id] = proxy;
        }

        this.loaded = true;
    }

    public static getById(id: string): Proxy | undefined {
        if (!this.loaded) this.load();
        return this.byId[id];
    }

    public static get(url: string, key: string = 'default'): Proxy | undefined {
        if (!this.loaded) this.load();

        const proxies = this.proxies[key] ?? this.proxies['default'];

        const hostname = new URL(url).hostname;
        if (proxies.length === 0) return undefined;

        const last = this.lastUsed[hostname];

        let cp: Proxy;
        if (!last || proxies.length === 1) {
            cp = this.random(proxies);
        } else {
            cp = this.random(proxies);
            while (cp === last) {
                cp = this.random(proxies);
            }
        }

        this.lastUsed[hostname] = cp;
        return cp;
    }

    public static toProxyServer(p: Proxy): string {
        return `${p.protocol ?? 'http'}://${p.host}:${p.port}`;
    }

    private static random(list: Proxy[]): Proxy {
        return list[Math.floor(Math.random() * list.length)];
    }
}
