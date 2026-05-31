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

The port `8080` will be forwarded to the `core_network` from the docker container.

The docker image will not compile in MacOS as there are limitations with the system libraries that are required from `puppeteer`.
