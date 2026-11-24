ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22.16-alpine
FROM ${NODE_IMAGE}

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache git openssh-client
# The container runs as `user: "1002:10"` (compose), and alpine has no record for that uid.
# `ssh` refuses to start without one, so `git push` over SSH fails with "No user exists for
# uid 1002". This is a name record, not a login: no password, shell /bin/sh, home /data.
RUN echo "app:x:1002:10:app:/data:/bin/sh" >> /etc/passwd

COPY package.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry "$NPM_REGISTRY" \
    && npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY . ./
# The image must not inherit file modes from the build machine's checkout. Measured 2026-11-21 on a
# failing build: /app/server.js and /app/package.json were root:root 770 while the just-changed
# authz-constraints.js was 664 — Docker reuses a cached COPY layer, so the modes of every UNCHANGED
# file are frozen at whatever the layer was built with, and a tree that once handed out 0770 keeps
# poisoning the image long after it stops doing so. The container runs as 1002:10, so a 770 root:root
# file is EACCES: the container crash-loops with `permission denied, open '/app/server.js'` and the
# deploy reports "unhealthy" after its budget. Normalize once, after the copy.
RUN chmod -R a+rX /app && chown -R 1002:10 /app

ENV HOST=0.0.0.0 \
    PORT=18923 \
    MCP_PATH=/mcp \
    VAULT_PATH=/vault \
    DATA_PATH=/data

RUN mkdir -p /vault /data

EXPOSE 18923

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const h={}; if (process.env.API_KEY) h[process.env.API_KEY_HEADER || 'X-API-Key']=process.env.API_KEY; fetch('http://127.0.0.1:' + (process.env.PORT || 18923) + '/healthz', {headers:h}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
