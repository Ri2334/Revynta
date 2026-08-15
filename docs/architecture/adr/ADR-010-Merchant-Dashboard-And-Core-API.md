# ADR-010: Merchant Dashboard & Core API Architecture

## Status
Accepted

## Context
Revynta requires a merchant-facing management system (control plane) to allow merchants to log in, select their store context, configure campaigns, rotate API ingestion keys, verify WhatsApp integrations, view real-time delivery logs, and track shopper conversion statistics.

We require:
- Cryptographically secure tenant isolation.
- Proper role-based access controls (RBAC).
- A performant frontend React client.
- Secure credential management preventing raw secret disclosure.
- Comprehensive audit logging for all sensitive operations.
- Parameterized queries to prevent SQL injection.

## Architecture

### Backend API (`apps/merchant-api`)
- **Stack**: Fastify 4 + TypeScript + `@fastify/cookie` + `@fastify/cors`
- **Port**: 3001 (configurable via `MERCHANT_API_PORT`)
- **Authentication**: JWT signed with `JWT_SECRET`, stored in HttpOnly/SameSite=Lax/Secure cookies
- **Authorization**: RBAC via `authorizeRoles(['owner', 'admin'])` middleware

### Frontend SPA (`apps/dashboard-web`)
- **Stack**: React + Vite + Tailwind CSS
- **State**: Local React state + fetch to `http://localhost:3001/api/v1`
- **Auth flow**: Cookie-based session (no localStorage to prevent XSS leakage)

## Decisions

### 1. Separation of Concerns
- Backend Core API (`apps/merchant-api`) running Fastify + TypeScript (highly performant, aligned with ingestion stack).
- Frontend SPA (`apps/dashboard-web`) running React + Vite + Tailwind CSS.
- These are intentionally separate from `ingestion-api` (high-throughput clickstream) to isolate compute resources under load.

### 2. Session Authentication & CSRF Guard
- Authentication via signed JSON Web Tokens (JWT) stored in HttpOnly, SameSite=Lax, Secure cookies. This prevents local storage XSS extraction.
- `signToken()` uses `jsonwebtoken.sign()` with a 24-hour expiry.
- Passwords hashed with `crypto.scryptSync(password, salt, 64)` — not bcrypt, avoiding libuv thread pool saturation.

### 3. Explicit Multi-Tenant Context Binder
- All requests specify store context via the `x-store-id` header (or fall back to user's primary store).
- `authenticateMerchant` middleware validates that the requested `storeId` resides within the user's organization memberships via `withAdminContext` (IDOR verification).
- Once validated, all store-scoped queries run via `withStoreContext(storeId, ...)` which sets PostgreSQL `app.current_store_id` for RLS enforcement.
- This provides **defense-in-depth**: middleware IDOR check + PostgreSQL RLS both enforce tenant boundaries.

### 4. Credential Masking & One-Time API Key Display
- WhatsApp access tokens are stored AES-256-encrypted via `encryptPII()` and **never returned** in any GET response.
- Ingestion API keys are displayed raw exactly once upon creation (`rawKey` in POST response only).
- Keys are stored as SHA-256 hashes only (`key_hash`). The raw key is never stored.
- API key list endpoint returns only: `id`, `key_prefix`, `name`, `status`, `expires_at`, `created_at`.

### 5. Audit Logging
- All sensitive mutations emit non-blocking audit records to `audit_logs` via `withAdminContext`:
  - Campaign created/updated/toggled/archived
  - API key created/revoked
  - WhatsApp integration configured
- Audit metadata **deliberately excludes** raw API keys, access tokens, or passwords.
- Only organization owner and admin roles may read audit logs.

### 6. Directed Graph Webhook Status Transitions (Phase 9)
- WhatsApp message statuses are transitioned according to a strict directed-graph validation matrix.
- `failed` can only transition to `failed` (terminal), not overwrite `delivered` or `read`.
- This prevents late or out-of-order webhook delivery state regressions.

### 7. Analytics Architecture
- **PostgreSQL analytics**: `GET /api/v1/analytics/overview`, `GET /api/v1/analytics/intent`, `GET /api/v1/analytics/campaigns` — all computed from tenant-scoped `message_logs`, `shoppers`, and `campaigns` tables.
- **ClickHouse analytics**: `GET /api/v1/analytics/funnel` — event funnel from `events_analytics` table. Uses **parameterized queries** (`{storeId:UUID}`) to prevent SQL injection.
- ClickHouse failures trigger graceful fallback to zero aggregates (no 500 to merchant).

## API Endpoints

### Authentication
| Method | Path | Auth | Roles |
|--------|------|------|-------|
| POST | `/api/v1/auth/register` | None | - |
| POST | `/api/v1/auth/login` | None | - |
| POST | `/api/v1/auth/logout` | Cookie | Any |
| GET | `/api/v1/auth/me` | Cookie | Any |

### Stores
| Method | Path | Auth | Roles |
|--------|------|------|-------|
| GET | `/api/v1/stores` | Cookie | Any |
| GET | `/api/v1/stores/:id` | Cookie + IDOR | Any |
| PUT | `/api/v1/stores/:id` | Cookie + IDOR | owner, admin |

### Campaigns
| Method | Path | Auth | Roles |
|--------|------|------|-------|
| GET | `/api/v1/campaigns` | Cookie | Any |
| GET | `/api/v1/campaigns/:id` | Cookie | Any |
| POST | `/api/v1/campaigns` | Cookie | owner, admin |
| PUT | `/api/v1/campaigns/:id` | Cookie | owner, admin |
| POST | `/api/v1/campaigns/:id/toggle` | Cookie | owner, admin |
| DELETE | `/api/v1/campaigns/:id` | Cookie | owner, admin |
| GET | `/api/v1/campaigns/:id/preview` | Cookie | Any |

### WhatsApp Integration
| Method | Path | Auth | Roles |
|--------|------|------|-------|
| GET | `/api/v1/integrations/whatsapp` | Cookie | Any |
| POST | `/api/v1/integrations/whatsapp` | Cookie | owner, admin |
| POST | `/api/v1/integrations/whatsapp/toggle` | Cookie | owner, admin |

### API Keys
| Method | Path | Auth | Roles |
|--------|------|------|-------|
| GET | `/api/v1/api-keys` | Cookie | Any |
| POST | `/api/v1/api-keys` | Cookie | owner, admin |
| DELETE | `/api/v1/api-keys/:id` | Cookie | owner, admin |

### Analytics & Logs
| Method | Path | Auth | Roles |
|--------|------|------|-------|
| GET | `/api/v1/messages` | Cookie | Any |
| GET | `/api/v1/audit-logs` | Cookie | owner, admin |
| GET | `/api/v1/analytics/overview` | Cookie | Any |
| GET | `/api/v1/analytics/intent` | Cookie | Any |
| GET | `/api/v1/analytics/campaigns` | Cookie | Any |
| GET | `/api/v1/analytics/funnel` | Cookie | Any |

## Role Hierarchy
```
owner > admin > member > viewer
```
- **owner**: Full access to all operations
- **admin**: All operations except org-level ownership transfers
- **member**: Read + own store operations (reserved for future)
- **viewer**: Read-only access to campaigns, messages, analytics

## Security Properties
1. **Tenant isolation**: Every store-scoped query uses `withStoreContext` which sets PostgreSQL RLS context + explicit `WHERE store_id = storeId` clause (defense-in-depth).
2. **IDOR protection**: `authenticateMerchant` validates `x-store-id` ∈ `user.accessibleStoreIds` for every request before any DB query.
3. **Credential security**: No raw secrets in DB, no secrets in API responses, secrets encrypted at rest.
4. **Audit trail**: All mutations auditable; audit logs are scoped to organization and require owner/admin role to read.
5. **Parameterized SQL**: All PostgreSQL queries use Knex parameterization. ClickHouse queries use `{param:Type}` syntax.

## Alternatives Considered
- **Single Monolithic API**: Rejected. Splitting `ingestion-api` (high-throughput clickstream data) and `merchant-api` (low-frequency transactional analytics) isolates compute resources under heavy load.
- **Enterprise IAM / Keycloak**: Rejected. The lightweight, built-in schema (users, memberships, stores) is highly portable and has zero external operational overhead.
- **Cookie-free Bearer Token Auth**: Rejected. HttpOnly cookies prevent JavaScript token theft via XSS.
- **LocalStorage Session**: Rejected. Vulnerable to XSS attacks.

## Testing
- 21 integration tests in `apps/merchant-api/test/merchant_api.test.ts`
- Tests cover: auth, IDOR/RBAC, campaign CRUD, API key lifecycle, WhatsApp isolation, analytics tenant isolation, audit logs, intent analytics, and response format validation
- All tests run against real PostgreSQL with RLS enforcement

## Related ADRs
- ADR-007: Explainable Deterministic Intent Engine
- ADR-009: WhatsApp Integration
