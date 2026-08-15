# ADR-012: Production Observability, Security & Hardening Strategy

## Status
Accepted

## Context
Revynta requires production-grade observability (logging, metrics, distributed tracing, health checks, error taxonomy) and security hardening (multi-tenant RLS, IDOR checks, secret/PII redaction, rate limiting, request validation) to support reliable multi-tenant operations.

## Decisions

### 1. Zero External Observability SaaS Dependency
- Implement built-in Pino structured logging with redaction, Prometheus `/metrics` format exporter, OpenTelemetry-compatible trace span helpers, and HTTP/Kafka correlation IDs.
- Rationale: Avoids mandatory external SaaS subscriptions (Datadog/Grafana Cloud) for local development and self-hosted deployments while exposing industry-standard metrics formats.

### 2. Liveness vs Readiness Check Separation
- **`/health/liveness`**: Returns `200 OK` instantly without querying databases. Prevents premature process kills during temporary upstream outages.
- **`/health/readiness`**: Performs 2-second timeout healthchecks against PostgreSQL, Redis, and Kafka. Returns `503` if required dependencies are unreachable.

### 3. Automatic PII & Secret Redaction
- Configured Pino redactor to censor sensitive keys (`password`, `password_hash`, `accessToken`, `rawKey`, `key_hash`, `authorization`, `cookie`, `encrypted_value`) in all log streams.

### 4. Correlation ID Propagation
- `x-correlation-id` is generated on HTTP request entry or preserved from incoming headers, and injected into Kafka message headers to trace requests across worker boundaries.

### 5. Multi-Tenant RLS & Security Verification
- All PostgreSQL operations enforce Row Level Security (`FORCE ROW LEVEL SECURITY`). IDOR checks in Fastify middleware verify active store membership.

## Consequences
- Operational visibility across all services without performance overhead.
- Industry-standard Prometheus integration.
- Guaranteed zero PII or secret leakage in logs.
