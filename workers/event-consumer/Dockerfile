# Multi-stage Dockerfile for @revynta/event-consumer workers
FROM node:22-alpine AS builder

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy root configuration and dependency definitions
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ ./packages/
COPY workers/event-consumer/ ./workers/event-consumer/

# Install dependencies and build event-consumer worker and all workspace dependencies
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @revynta/event-consumer... build

# Production runner stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/workers/event-consumer ./workers/event-consumer

RUN pnpm install --prod --frozen-lockfile

# Default worker role runs all consumers in single container stack unless overridden
ENV CONSUMER_TYPE=all

CMD ["node", "workers/event-consumer/dist/index.js"]
