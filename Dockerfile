# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-bookworm AS builder

WORKDIR /app

RUN corepack enable pnpm

# Install dependencies (including native build tools for better-sqlite3)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build TypeScript backend + Angular UI
COPY . .
ARG GIT_HASH=unknown
ENV GIT_HASH=${GIT_HASH}
RUN pnpm run build:all

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# Runtime system dependencies
# - better-sqlite3 native .node is already compiled in node_modules from builder
# - playwright browsers (optional — only needed if web_crawl is configured)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Uncomment to enable playwright-based web crawling:
# RUN npx playwright install --with-deps chromium

# Copy compiled application
COPY --from=builder /app/dist            ./dist
COPY --from=builder /app/public          ./public
COPY --from=builder /app/templates       ./templates
COPY --from=builder /app/node_modules    ./node_modules
COPY --from=builder /app/package.json    ./package.json

# Entrypoint handles vault key bootstrap
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Data directory — mount a named volume here
ENV VEROX_HOME=/data
VOLUME ["/data"]

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
