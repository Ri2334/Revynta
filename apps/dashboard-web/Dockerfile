# Multi-stage Dockerfile for @revynta/dashboard-web SPA
FROM node:22-alpine AS builder

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy root configuration and dependency definitions
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/dashboard-web/ ./apps/dashboard-web/

# Accept build-time API base URL arg (default to production gateway)
ARG VITE_API_BASE_URL=https://13.201.129.139.sslip.io/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

# Install dependencies and build frontend static bundle
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @revynta/dashboard-web... build

# Production static Nginx web server stage
FROM nginx:alpine AS runner

# Custom SPA Nginx config for client-side routing fallback
RUN echo $'server {\n\
    listen 80;\n\
    location / {\n\
        root /usr/share/nginx/html;\n\
        index index.html;\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}' > /etc/nginx/conf.d/default.conf

COPY --from=builder /app/apps/dashboard-web/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
