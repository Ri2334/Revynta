# Multi-stage Dockerfile for @revynta/merchant-api
FROM node:22-alpine AS builder

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy root configuration and dependency definitions
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/merchant-api/ ./apps/merchant-api/

# Install dependencies and build merchant API and all workspace dependencies
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @revynta/merchant-api... build

# Production runner stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV MERCHANT_API_PORT=3001
ENV MERCHANT_API_HOST=0.0.0.0

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/merchant-api ./apps/merchant-api

RUN pnpm install --prod --frozen-lockfile

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3001/health/liveness || exit 1

CMD ["node", "apps/merchant-api/dist/index.js"]
