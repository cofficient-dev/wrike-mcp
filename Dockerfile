# --- build stage ------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm ci --omit=dev

# --- runtime stage -----------------------------------------------------------
FROM node:22-bookworm-slim
# dumb-init: proper PID 1 signal handling (SIGTERM -> graceful shutdown)
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 wrike \
    && useradd --system --uid 1001 --gid wrike --home-dir /app wrike

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    TOKEN_STORE_PATH=/var/lib/wrike-mcp/tokens.json

# runtime deps only (from the build stage's --omit=dev install)
COPY --from=build --chown=wrike:wrike /app/node_modules ./node_modules
COPY --from=build --chown=wrike:wrike /app/dist ./dist
COPY --chown=wrike:wrike package.json ./

# encrypted token store volume
RUN mkdir -p /var/lib/wrike-mcp && chown -R wrike:wrike /var/lib/wrike-mcp
VOLUME /var/lib/wrike-mcp

USER wrike
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]