# --- Dependency Stage ---
FROM node:20-alpine AS deps

RUN corepack enable && corepack prepare pnpm@10.4.1 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml ./

# KEY OPTIMIZATIONS:
# 1. node-linker=hoisted → flat node_modules, no .pnpm store (~800MB saved)
# 2. PRISMA_SKIP_POSTINSTALL → skip downloading engines (copied from builder instead)
# 3. Strip docs/tests/changelogs/sourcemaps from every package
RUN echo "node-linker=hoisted" > .npmrc && \
    PRISMA_SKIP_POSTINSTALL=1 pnpm install --frozen-lockfile --prod && \
    # Remove junk files from node_modules
    find node_modules \( \
      -name "*.md" -o -name "*.map" -o -name "CHANGELOG*" -o \
      -name "LICENSE*" -o -name ".npmignore" -o -name "Makefile" \
    \) -type f -delete 2>/dev/null; \
    find node_modules -type d \( \
      -name "test" -o -name "tests" -o -name "__tests__" -o \
      -name "docs" -o -name "doc" -o -name "example" -o -name "examples" \
    \) -exec rm -rf {} + 2>/dev/null; \
    true

# --- Builder Stage ---
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.4.1 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy Prisma schema and generate client
COPY prisma ./prisma/
RUN pnpm run db:generate

# Copy source code and config
COPY tsconfig.json ./
COPY src ./src/

# Build the application
RUN pnpm run build

# --- Production Stage ---
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Create a non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package.json ./
COPY prisma ./prisma/

# Copy flat production node_modules (no .pnpm store!)
COPY --from=deps /app/node_modules ./node_modules

# Replace the stub @prisma from deps with the fully generated one from builder.
# Must delete first — deps (hoisted) creates a directory, builder (symlinks) creates a file,
# and Docker COPY can't overwrite a directory with a file.
RUN rm -rf node_modules/@prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Copy compiled files from builder
COPY --from=builder /app/dist ./dist

# Final permissions for the non-root user
RUN chown -R appuser:appgroup /app
USER appuser

# Runtime env vars: DATABASE_URL, CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, PORT (default 3001)
EXPOSE 3001
CMD ["node", "dist/server.js"]

# NOTE: Database migrations (prisma migrate deploy) should be run at deployment time,
# not during the image build process, to ensure they run against the live database.
