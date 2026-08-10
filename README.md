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
| `BROWSER_ENGINE` | `cloak` | `cloak` (stealth, headful) or `puppeteer` (headless fallback) |
| `DEBUG` | *(off)* | Per-attempt logging. `1`/`true`/`yes`/`on` |
| `PROXIES_FILE` | `./proxies_default.txt` | Where the upstream proxy pool is read from |

## Proxy pool

`PROXIES_FILE` may point at **a file or a directory**; a directory has every regular file
in it concatenated. Dot-prefixed entries are skipped, which is what makes a Kubernetes
projected volume work — those directories also contain a `..data` symlink holding a
second copy of everything.

One `host:port:username:password` per line. Blank lines and `#` comments are ignored,
malformed lines are counted and skipped rather than becoming a proxy with a `NaN` port,
and duplicates are dropped so an entry cannot end up in the rotation twice. The count is
printed at startup — **check it**, because an empty pool is not an error:

```
Proxy pool: 1483 proxies from /app/pool
```

Missing or unreadable is deliberately not fatal: the proxy still serves, going out
directly. Losing Cloudflare-bypass capability beats refusing to start.

### Large pools

The file may be plain text, **gzip**, or **base64-wrapped gzip**, detected from the
content rather than the filename — the filename is fixed by whatever mounts it. The
base64 wrapper exists because a JSON secret store cannot hold raw gzip bytes. Detection
is self-checking: a decode is only accepted if it yields the gzip magic, so plain text
that happens to look like base64 is still read as text.

This matters above roughly **23,000 proxies**, where the pool passes the 1 MiB ceiling
that both a Kubernetes Secret and a Vault Raft entry impose:

```shell
gzip -9 -c proxies_default.txt | base64 -w0 > pool.b64   # macOS: base64 -i -
```

Compression buys much less than you would expect when every proxy has its own random
password — measured 2.2× for 50,000 unique credentials, against 9× when the credential is
shared across the pool. Deployment sizing, and the route for a pool too big even
compressed, are in
[`k3s/08-news-proxy/README.md`](https://github.com/ViaVeritasApp/k3s/blob/main/08-news-proxy/README.md)
section 1a.

> This is why the pool is a file and not an environment variable, and why it cannot
> become one: Linux caps a single environment variable at 128 KiB (`MAX_ARG_STRLEN`),
> about 2,800 proxies. Past that `execve` fails with `E2BIG` and the process never starts.

`proxies_default.txt` is gitignored and must stay that way — it holds credentials.
