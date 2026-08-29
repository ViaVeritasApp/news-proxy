import axios from 'axios';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Proxies, Proxy } from '../proxies.js';
import { isChallenge, isHardBlock } from '../cloudflare.js';
import { debug } from '../log.js';
import { FetchOutcome, FetchRequest, RequestEngine } from './types.js';
import { environment } from '../environment.js';


// The default engine: a plain HTTP forward, no browser.
class AxiosEngine implements RequestEngine {
    public readonly name = 'axios' as const;

    public async fetch(req: FetchRequest, proxy: Proxy | undefined): Promise<FetchOutcome> {
        try {
            const response = await axios.request({
                url: req.url,
                method: 'GET',
                headers: req.headers,
                timeout: environment.NAV_TIMEOUT,
                maxRedirects: 20,
                maxContentLength: environment.MAX_BODY_BYTES,
                responseType: 'arraybuffer',
                // Report the target's status rather than throwing: a 404 or 410 is a real
                // answer the caller needs to see, not a reason to burn a proxy rotation.
                validateStatus: () => true,
                ...this.agents(proxy),
            });

            const body = Buffer.from(response.data).toString('utf8');
            const contentType = response.headers['content-type'];

            // A plain client cannot solve a challenge, so any challenge page is terminal
            // for this engine — but it is still worth another IP, which is what `blocked`
            // asks the caller for. A source that keeps hitting this wants a browser engine.
            const blocked = isHardBlock(body) || isChallenge(body);
            if (blocked) debug(`axios: challenge/block markers in ${body.length}-byte body`);

            return {
                status: response.status,
                body,
                contentType: typeof contentType === 'string' ? contentType : undefined,
                blocked,
            };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            debug(`axios: transport error — ${message}`);
            return { status: 503, body: message, blocked: true };
        }
    }

    // axios' own `proxy` option does not CONNECT-tunnel https, so it must be an agent.
    private agents(proxy: Proxy | undefined) {
        if (!proxy) return {};

        const url = Proxies.toProxyUrl(proxy);
        return {
            proxy: false as const,
            httpAgent: new HttpProxyAgent(url),
            httpsAgent: new HttpsProxyAgent(url),
        };
    }
}

export const axiosEngine = new AxiosEngine();
