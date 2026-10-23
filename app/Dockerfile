ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22.16-alpine
FROM ${NODE_IMAGE}

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache git openssh-client

COPY package.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry "$NPM_REGISTRY" \
    && npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY . ./

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
