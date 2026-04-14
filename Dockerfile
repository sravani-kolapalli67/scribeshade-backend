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
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Create a non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# COPY EVERYTHING IN ONE GO WITH CORRECT PERMISSIONS
# This prevents the layer blowup caused by "chown -R"
COPY --from=staging --chown=appuser:appgroup /app /app

USER appuser
EXPOSE 3000

# Runtime env vars: DATABASE_URL, etc.
CMD ["node", "dist/server.js"]
