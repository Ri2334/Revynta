# Revynta Deep Handover & Context Architecture Document (`uptillnow.md`)

This document provides a highly detailed, comprehensive architectural map and code context for the **Revynta** platform. If loaded into a new AI session, this file contains everything needed to understand the codebase structure, database migrations, package dependencies, logic constraints, state machines, and testing boundaries without needing access to previous truncated chat history.

---

## 1. Project Context & Purpose

**Revynta** is a multi-tenant, event-driven SaaS platform designed for e-commerce stores to track shopper behavior, calculate real-time shopper intent scores, and automatically dispatch recovery campaigns (e.g. browse abandonment recovery) via outbound gateways (primarily WhatsApp).

The platform uses a decoupled, asynchronous, message-driven architecture built around a Kafka/Redpanda event pipeline, Redis session caches, PostgreSQL transactional databases (with Row-Level Security), and ClickHouse analytical databases.

---

## 2. Directory Structure & Codebase Map

The project is structured as a monorepo using `pnpm` workspaces:

```
revynta/
├── apps/
│   └── ingestion-api/                 # Fastify web server receiving browser SDK events
│       ├── src/
│       │   ├── auth.ts                # API key verification & Redis session key lookup
│       │   ├── index.ts               # HTTP server bootstrap & graceful shutdown hooks
│       │   ├── kafka.ts               # Ingestion pipeline publisher (produces events.raw)
│       │   └── routes.ts              # GET/POST endpoints & WhatsApp webhook callbacks
│       └── package.json
│
├── packages/
│   ├── config/                        # Shared multi-environment configuration settings
│   ├── database/                      # Transactional repository (Knex + pg + ClickHouse + Redis)
│   │   ├── src/
│   │   │   ├── migrations/            # SQL migration scripts
│   │   │   ├── campaignRepository.ts  # Database queries for campaigns, consent, and logs
│   │   │   ├── clickhouse.ts          # ClickHouse connection pool & analytics batching
│   │   │   ├── crypto.ts              # AES-256-GCM encryption at rest for PII and credentials
│   │   │   ├── index.ts               # Main package exports
│   │   │   ├── postgres.ts            # PostgreSQL pool and RLS context managers
│   │   │   └── redis.ts               # Redis connection pool and key utility mappings
│   │   └── package.json
│   │
│   ├── intent-engine/                 # Heuristic intent calculation package
│   │   ├── src/
│   │   │   ├── index.ts               # Decayed score & explanation factor mappings
│   │   │   └── types.ts               # Types definitions (IntentSignal, HeuristicConfig)
│   │   └── package.json
│   │
│   ├── observability/                 # Shared metrics package (Prometheus registry & pino logging)
│   ├── shared-types/                  # Shared TypeScript types for event schemas
│   └── tracking-sdk/                  # Client-side JS tracker (packaged via Vite)
│
├── workers/
│   └── event-consumer/                # Background consumers processing event streams
│       ├── src/
│       │   ├── consumers/
│       │   │   ├── identity-resolver.ts  # Resolves anonymous vs identified profiles
│       │   │   ├── inactivity-scheduler.ts# Schedules BullMQ delayed inactivity checks
│       │   │   ├── inactivity-worker.ts   # Performs final eligibility checking checks
│       │   │   ├── intent-scorer.ts       # Evaluates intent scores and persists signals
│       │   │   ├── purchase-handler.ts    # Suppresses campaigns post-purchase
│       │   │   ├── session-processor.ts   # Main event processor mapping sessions to Redis
│       │   │   └── whatsapp-dispatcher.ts # Consumes eligibility events and calls Meta API
│       │   │   └── whatsapp-provider/     # Abstraction folder
│       │   │       ├── factory.ts
│       │   │       ├── interface.ts
│       │   │       ├── meta.ts
│       │   │       └── mock.ts
│       │   ├── dlq.js                     # Dead-letter queue utility & backoff retries
│       │   ├── index.ts                   # Entry point starting workers by CONSUMER_TYPE
│       │   └── kafka-client.ts            # Shared Kafkajs configurations
│       └── test/
│           ├── consumers.test.ts          # Pipeline integration tests
│           ├── phase7_intent_engine.test.ts
│           ├── phase8_campaign_engine.test.ts
│           └── phase9_whatsapp.test.ts    # WhatsApp Gateway & Webhook tests
│
└── uptillnow.md                       # This handover document
```

---

## 3. Database Schema & Migration Details

### Transactional PostgreSQL Schemas (Phases 0–9)

All tables isolated by store are secured using PostgreSQL Row Level Security (RLS) policies. RLS policies bypass checking if `app.bypass_rls` is `'true'`.

#### Migration `20260815000000_initial_schema.ts` (Core schemas)
* **`organizations`**: Master accounts.
  * Columns: `id` (UUID, PK), `name` (VARCHAR), `created_at`, `updated_at`.
* **`stores`**: Multi-tenant tenants.
  * Columns: `id` (UUID, PK), `organization_id` (UUID, FK), `name` (VARCHAR), `domain` (VARCHAR), `status` (VARCHAR), `created_at`, `updated_at`.
* **`memberships`**: Maps users to orgs.
  * Columns: `id` (UUID, PK), `organization_id` (UUID, FK), `user_id` (UUID), `role` (VARCHAR).
* **`api_keys`**: Authenticates client SDK ingestion batch sends.
  * Columns: `id` (UUID, PK), `store_id` (UUID, FK), `key_hash` (VARCHAR), `status` (VARCHAR).
* **`shoppers`**: Shopper records.
  * Columns: `id` (UUID, PK), `store_id` (UUID, FK), `intent_score` (INT), `intent_segment` (VARCHAR), `first_seen`, `last_seen`.
* **`shopper_identities`**: Hashed and encrypted shopper contact details (phone, email).
  * Columns: `id` (UUID, PK), `store_id` (UUID, FK), `shopper_id` (UUID, FK), `channel` (VARCHAR), `identifier_hash` (VARCHAR UNIQUE), `encrypted_value` (TEXT).
* **`consent_records`**: Marketing authorization tracking.
  * Columns: `id` (UUID, PK), `store_id` (UUID, FK), `shopper_id` (UUID, FK), `purpose` (VARCHAR), `status` (VARCHAR), `source` (VARCHAR), `withdrawn_at` (TIMESTAMP).
* **`campaigns`**: Retention campaigns.
  * Columns: `id` (UUID, PK), `store_id` (UUID, FK), `name` (VARCHAR), `status` (VARCHAR), `trigger_type` (VARCHAR), `inactivity_duration_minutes` (INT), `min_intent_score` (INT), `communication_channel` (VARCHAR), `template_id` (VARCHAR), `cooldown_seconds` (INT), `deleted_at` (TIMESTAMP).
* **`message_logs`**: Outbound gateways records.
  * Columns: `id` (UUID, PK), `store_id` (UUID, FK), `shopper_id` (UUID, FK), `campaign_id` (UUID, FK), `channel` (VARCHAR), `provider` (VARCHAR), `provider_message_id` (VARCHAR UNIQUE), `template_id` (VARCHAR), `status` (VARCHAR), `failure_reason` (TEXT), `idempotency_key` (VARCHAR UNIQUE), `sent_at`, `delivered_at`, `read_at`, `failed_at`.
* **`integrations`**: WhatsApp phone credentials.
  * Columns: `id` (UUID, PK), `store_id` (UUID, FK), `provider` (VARCHAR), `configuration` (JSONB), `status` (VARCHAR).

#### Migration `20260815120000_intent_engine_schema.ts` (Intent schemas)
* **`shopper_intent`**: Persistent scorer states.
  * Columns: `id` (UUID), `store_id` (UUID), `shopper_id` (UUID), `intent_score` (INT), `intent_segment` (VARCHAR), `explanations` (JSONB), `model_version` (VARCHAR).
* **`purchase_suppression`**: Multi-tenant converted shoppers check.
  * Columns: `id` (UUID), `store_id` (UUID), `shopper_id` (UUID), `suppressed_at`, `expires_at`, `model_version`.
* **`event_dedup`**: Deduplicates incoming consumer events.
  * Columns: `id` (UUID), `store_id` (UUID), `consumer_group` (VARCHAR), `event_id` (VARCHAR).

---

## 4. Key Logic Configurations & Constraints

### A. Heuristic Intent weights
Calculated inside `@revynta/intent-engine`:
* Default Action Weights:
  * Page View: `+1`
  * Product View: `+5`
  * Repeat Product View: `+10`
  * Cart Add: `+25`
  * Checkout Init: `+50`
* Exponential Recency Decay:
  * Signal score is calculated via: $\text{Weight} \times 0.5^{\frac{\Delta t}{T_{1/2}}}$ where $\Delta t$ is the duration elapsed since the signal event occurred.
  * $T_{1/2}$ (half-life) durations:
    * Standard events: `48 hours`
    * Search keywords: `24 hours`
    * Purchase/suppression actions: `0 hours` (No decay, terminal state).
* Intent Segments:
  * Low: `0 to 29`
  * Medium: `30 to 69`
  * High: `70 to 100`

### B. Redis Sessions & Affinity Trimming
* Session HASH key: `session:{tenantId}:{sessionId}`
* Affinity ZSET key: `affinity:{dimension}:{tenantId}` (dimensions are `product` and `category`).
* **Affinity Cap**: Limited to exactly **200 entries** per ZSET to restrict memory overhead. The session-processor consumer trims records using `ZREMRANGEBYRANK affinityKey 0 -201` after updates.
* **Purchase Suppression TTL**: Redis key `purchased_recently:{tenantId}:{shopperId}` set on purchase with a strict **24-hour expiry (86,400 seconds)**.

### C. BullMQ Job Scheduling & Failed-Job Bounded Retention
* **Inactivity Scheduler** (`inactivity-scheduler.ts`): Schedules BullMQ delayed jobs with custom IDs.
  * Job ID structure: `inactivity_${tenantId}_${sessionId}_${campaignId}` (Colons `":"` must never be used in BullMQ custom job IDs as it disrupts Redis namespace mapping).
* **Failed-Job Retention**: To prevent Redis memory expansion under repeated failures, failed jobs are bounded:
  ```ts
  removeOnFail: {
    age: 24 * 3600, // Keep failed jobs for up to 24 hours max
    count: 1000,    // Keep at most 1000 failed jobs max
  }
  ```
* **NTP Clock Sync Margin**: Delayed Verification stale checking applies a **5-second safety buffer** to account for minimal network latency and cluster clock drift between nodes. Production servers must run NTP synchronization.

---

## 5. Webhook Status Transition Matrix

Status updates from Meta WhatsApp callback webhooks are verified and processed in `apps/ingestion-api/src/routes.ts`. Out-of-order delivery callback events are guarded using a strict directed graph transition validation mapping:

```ts
const validTransitions: Record<string, string[]> = {
  pending: ['sent', 'delivered', 'read', 'failed'],
  sent: ['delivered', 'read', 'failed'],
  delivered: ['read'],
  read: [],   // Terminal successful state
  failed: [], // Terminal failed state
};
```

### Transition Resolution Rules:
- If a message is currently `'read'` in PostgreSQL, it can *never* transition to `'sent'`, `'delivered'`, or `'failed'`.
- If a message is currently `'delivered'`, it can *only* transition to `'read'`. Stale webhooks attempting to set status back to `'sent'` or `'failed'` are ignored.
- If a message is `'failed'`, it remains `'failed'` forever.
- Transition requests must satisfy `validTransitions[currentStatus].includes(incomingStatus)` to proceed.

---

## 6. End-to-End Test Suite Reference

All integration test cases are written using Vitest and execute in sequential execution.

### Test Files & Covered Scenarios

#### 1. Ingestion & Consumers Pipeline (`test/consumers.test.ts`)
* **Identity Resolution**: Subscribes to `events.raw`, hashes email/phone, inserts shopper identity, resolves visitor, and publishes `events.enriched`.
* **ClickHouse Writer**: Buffers enriched events and writes them in batches into ClickHouse `events_analytics`.

#### 2. Intent Engine calculations (`test/phase7_intent_engine.test.ts`)
* **Signals weights**: Fires views and cart additions, ensuring scores sum correctly.
* **Affinity Caps**: Adds 250 distinct products to the affinity ZSET, asserting that Redis trims the ZSET down to exactly the top 200 items.

#### 3. Inactivity Scheduling (`test/phase8_campaign_engine.test.ts`)
* **Basic Inactivity**: A shopper becomes inactive $\rightarrow$ inactivity job schedules $\rightarrow$ job fires $\rightarrow$ eligibility check evaluates $\rightarrow$ campaign eligible action publishes to `events.campaign.eligible`.
* **Stale Job Check (Returning Shopper)**: Shopper returns before delay expires $\rightarrow$ `last_event_timestamp` updates $\rightarrow$ delayed job fires and prunes itself safely without dispatch.
* **Consent checks**: Denied consent blocks campaign.
* **Tenant Isolation**: Non-superuser context set-role checks verify that Store A context cannot leak, read, or modify Store B logs.

#### 4. WhatsApp Gateway & Webhooks (`test/phase9_whatsapp.test.ts`)
* **Successful Send**: Consumes eligible event $\rightarrow$ safety check passes $\rightarrow$ Meta provider mock resolves success $\rightarrow$ logs `'sent'` to database.
* **Deduplication**: Duplicate Kafka events are handled via PostgreSQL database `idempotency_key` unique constraints.
* **HMAC Verification**: GET challenge tokens and POST webhook signature validation checks.
* **Transition Matrix**: Verifies all 11 state machine transitions (e.g. `delivered -> read` allowed, `read -> failed` blocked, `delivered -> sent` ignored).
* **Opt-Out STOP**: Inbound webhook STOP payload $\rightarrow$ revokes marketing consent $\rightarrow$ records campaign audit log.

---

## 7. Next Steps for Phase 10 (Merchant Dashboard & Core API)

When you resume development for Phase 10:
1. **Merchant API Setup**: Setup `apps/merchant-api` web service. Secure endpoints using JSON Web Tokens (JWT) containing merchant roles.
2. **Context Injection**: Extract the merchant's `storeId` or `organizationId` from the JWT and inject it into Knex database connection pools via `withStoreContext` or `withOrgContext` to enforce row-level security.
3. **Analytics Funnels**: Write ClickHouse aggregate queries to fetch:
   - Funnel mapping: Visitors $\rightarrow$ Product Views $\rightarrow$ Cart Adds $\rightarrow$ Checkouts $\rightarrow$ Purchases.
   - Conversion metrics: Recovery Rate = $\frac{\text{Message log status 'read' with linked purchases}}{\text{Total message logs dispatched}}$.
4. **Dashboard Frontend**: Setup React dashboard interface allowing merchants to configure verify tokens, campaign parameters, and view performance charts.
