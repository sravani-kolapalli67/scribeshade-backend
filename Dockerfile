# --- Dependency Stage ---
FROM node:20-alpine AS deps

RUN corepack enable && corepack prepare pnpm@10.4.1 --activate && \
    apk add --no-cache curl

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

# 1. Install only production dependencies
# 2. Use node-prune to clean up bloat
RUN echo "node-linker=hoisted" > .npmrc && \
    PRISMA_SKIP_POSTINSTALL=1 pnpm install --frozen-lockfile --prod && \
    curl -sf https://gobinaries.com/tj/node-prune | sh && \
    node-prune && \
    rm -rf node_modules/**/README.md node_modules/**/*.map 2>/dev/null

# --- Builder Stage ---
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.4.1 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN echo "node-linker=hoisted" > .npmrc && pnpm install --frozen-lockfile

# Copy Prisma schema and generate client
COPY prisma ./prisma/
RUN pnpm run db:generate

# Copy source code and build
COPY tsconfig.json ./
COPY src ./src/
RUN pnpm run build && \
    # Clean builder node_modules too to keep intermediate layers sane
    apk add --no-cache curl && \
    curl -sf https://gobinaries.com/tj/node-prune | sh && \
    node-prune node_modules

# --- Staging Stage (Merge everything for final COPY) ---
FROM node:20-alpine AS staging
WORKDIR /app

# 1. Copy prod node_modules from deps
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json

# 2. Overwrite prisma client with the generated one from builder
# Doing this in a separate stage ensures the final runner only gets one layer.
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist

# 3. Final engine cleanup (only keep musl engine for alpine)
RUN find node_modules/.prisma/client -name "query-engine-*" ! -name "*musl*" -delete 2>/dev/null || true

# --- Production Stage ---
# Use the official Playwright image as the runner base so Chromium is
# pre-installed at the exact path Playwright expects.
# The Playwright version here MUST match the version in package.json.
# Check with: node -e "require('playwright/package.json').version"
FROM mcr.microsoft.com/playwright:v1.59.1-noble AS runner

WORKDIR /app
ENV NODE_ENV=production
# Tell Playwright where its browsers already live in this image.
# The official image installs them under /ms-playwright.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install Node 20 (Playwright base image ships with the correct Node via nvm,
# but pinning ensures we match the rest of the pipeline).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user that matches the appuser convention used previously.
# The Playwright image already has a 'pwuser'; we create appuser separately
# so the existing file-permission model is unchanged.
RUN groupadd -r appgroup && useradd -r -g appgroup appuser

# Copy built artefacts from the staging stage with correct ownership in one layer.
COPY --from=staging --chown=appuser:appgroup /app /app

# Playwright browser binaries need to be readable by appuser.
RUN chmod -R o+rX /ms-playwright

USER appuser
EXPOSE 3000

CMD ["node", "dist/server.js"]
