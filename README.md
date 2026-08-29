# Proxy

This repository holds the intermediate proxy, a simple node.js application with the help of puppeteer to bypass Cloudflare protected sites.

## Setup

### Native

Install packages:

```shell
npm install
```

Install puppeteer chrome plugin:

```shell
npx puppeteer browsers install chrome
```

Start the proxy:

```shell
npm run start
```

### Docker

Use the `docker compose` command to create and start the container.

```shell
docker compose up --build -d
```

The server listens on `3000`; `docker-compose.yml` publishes it as `3123` on the host and
joins `core_network`, where other containers reach it as `news_proxy:3000`. In the cluster
it is `news-proxy:3000`.

The docker image will not compile in MacOS as there are limitations with the system libraries that are required from `puppeteer`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `BROWSER_ENGINE` | `axios` | Engine when a request names none: `axios` (plain forward), `puppeteer`, `cloak` |
| `PROXIES_<CC>` | *(none)* | One per country, e.g. `PROXIES_JP`. The pool inline or a path to it |
| `DEBUG` | `false` | Per-attempt logging |
| `RESPONSE_TIMEOUT` | `5000` | How long a browser engine waits for a challenge to clear |
| `MAX_RETRIES_CAP` | `3` | Upper bound on `X-Proxy-Max-Retries` |
| `NAV_TIMEOUT` | `30000` | Per-attempt request/navigation timeout |
| `MAX_BODY_BYTES` | `33554432` | Response size ceiling |
| `FORWARD_USER_AGENT` | Firefox 144 | Default `User-Agent` sent upstream |
| `FORWARD_ACCEPT` | browser `Accept` | Default `Accept` sent upstream |
| `FORWARD_ACCEPT_LANGUAGE` | `en-US,en;q=0.5` | Default `Accept-Language` sent upstream |

Everything is read in [`src/environment.ts`](src/environment.ts) via `envalid`.

## Request headers

`GET /<target url>`. Control headers are consumed here and never forwarded:

| Header | Purpose |
|---|---|
| `X-Browser-Engine` | `axios` \| `puppeteer` \| `cloak` |
| `X-Proxy-Country` | 2-letter code; a country with no pool falls back to a random proxy |
| `X-Proxy-Use` | `false` to connect directly |
| `X-Proxy-ID` | Pin one proxy by id |
| `X-Proxy-Max-Retries` | Rotations on a blocked attempt |
| `X-Proxy-Timeout` | Challenge wait budget |
| `X-Proxy-Wait-Until` | Browser engines: `load`, `domcontentloaded`, `networkidle0`, `networkidle2` |
| `X-C-<name>` | Override an outgoing header. Empty value removes it |

`X-C-User-Agent` and `X-C-Accept-Language` are applied through the browser APIs on the
browser engines, so `navigator.userAgent` and `navigator.languages` stay consistent with
the headers. Connection-level headers (`Connection`, `Host`, `Content-Length`, …) and the
`Sec-Fetch-*` / `Sec-CH-*` families are dropped for those engines — Chrome computes them,
and a hand-written value contradicts the rest of the request.

## Proxy pool

Pools come from `PROXIES_<CC>` environment variables, one per country — there is no pool
file. A request naming a country with no pool, or naming none, draws at random from every
proxy loaded.

One `host:port:username:password` per line (commas also work). Blank lines and `#`
comments are ignored, malformed lines are counted and skipped rather than becoming a proxy
with a `NaN` port, and duplicates are dropped per pool. Counts are printed at startup —
**check them**, because an empty pool is not an error:

```
Proxy pool jp: 12 proxies from $PROXIES_JP
```

A value containing no `:` is treated as a path to a file instead, which is the escape
hatch for a pool too large for one variable: Linux caps a single environment variable at
128 KiB (`MAX_ARG_STRLEN`), roughly 2,800 proxies, past which `execve` fails with
`E2BIG` and the process never starts.
