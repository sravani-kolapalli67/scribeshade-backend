# --- Builder Stage ---
FROM node:20-alpine AS builder

# Install pnpm via corepack
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

WORKDIR /app

# Copy dependency files first for layer caching
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDeps for building)
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

# Install pnpm via corepack (needed for generate in production stage)
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Create a non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy necessary files for production dependencies
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/

# Install only production dependencies
RUN pnpm install --frozen-lockfile --prod

# Re-generate Prisma client for the production node_modules
RUN pnpm run db:generate

# Copy compiled files from builder
COPY --from=builder /app/dist ./dist

# Final permissions for the non-root user
RUN chown -R appuser:appgroup /app
USER appuser

# Documentation on required runtime environment variables:
# - DATABASE_URL
# - CLERK_PUBLISHABLE_KEY
# - CLERK_SECRET_KEY
# - PORT (defaults to 3001)

EXPOSE 3001

# Start the application
CMD ["node", "dist/server.js"]

# NOTE: Database migrations (prisma migrate deploy) should be run at deployment time, 
# not during the image build process, to ensure they run against the live database.
