FROM --platform=linux/amd64 node:22-slim

WORKDIR /app

# Install latest chrome dev package and fonts to support major charsets (Chinese, Japanese, Arabic, Hebrew, Thai and a few others)
# Note: this installs the necessary libs to make the bundled version of Chromium that Puppeteer
# installs, work.
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 xvfb xauth \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json .

# Install puppeteer & other dependencies
RUN npm install \
    # Add user so we don't need --no-sandbox.
    # same layer as npm install to keep re-chowned files from using up several hundred MBs more space
    && groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    # Pre-create the cloak binary cache so the named volume inherits pptruser ownership.
    && mkdir -p /home/pptruser/.cloakbrowser \
    && mkdir -p /app \
    && chown -R pptruser:pptruser /app \
    && chown -R pptruser:pptruser /home/pptruser \
    && chown -R pptruser:pptruser /app/node_modules \
    && chown -R pptruser:pptruser /app/package.json \
    && chown -R pptruser:pptruser /app/package-lock.json

COPY . .

RUN npm run build && chmod +x /app/docker-entrypoint.sh

USER pptruser

ARG GIT_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT}

# Starts Xvfb for the headful cloak engine, then execs node as PID 1.
CMD ["/app/docker-entrypoint.sh"]
