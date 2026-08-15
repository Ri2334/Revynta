# Event-Processing Pipeline Architecture

This document describes the event-processing pipeline for the Revynta browse-abandonment platform, detailing the flow of telemetry from the browser SDK through the ingestion layers to our analytics and intent databases.

---

## 1. Pipeline Topology

```
             ┌─────────────────────────┐
             │       Tracking SDK      │
             └────────────┬────────────┘
                          │ HTTPS POST event batch
                          v
             ┌─────────────────────────┐
             │      Ingestion API      │
             └────────────┬────────────┘
                          │ Publish raw JSON
                          v
                   [ TOPIC: events.raw ]
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
┌──────────────────────┐     ┌─────────────────────┐
│ raw-event consumer   │     │ raw-event consumer  │ (Group: ingestion-enricher-group)
└───────────┬──────────┘     └──────────┬──────────┘
            │ Enriched events           │
            ├───────────────────────────┤
            ▼                           ▼
  [ TOPIC: events.identity ]    [ TOPIC: events.enriched ]
            │                           │
            │                           ├───────────────────────────────────────┐
            ▼                           ▼                                       ▼
┌──────────────────────┐     ┌──────────────────────┐                ┌──────────────────────┐
│  identity consumer   │     │  analytics consumer  │                │  session consumer    │
│ (PostgreSQL Writer)  │     │ (ClickHouse Batch)   │                │ (Redis & Postgres)   │
└──────────────────────┘     └──────────────────────┘                └──────────────────────┘
(Group: identity-resolver)   (Group: clickhouse-writer)              (Group: session-processor)
                                        │                                       │
                                        ▼                                       ▼
                             ┌──────────────────────┐                ┌──────────────────────┐
                             │ intent-event consumer│                │  purchase consumer   │
                             │ (Calculates scores)  │                │ (Locks campaigns)    │
                             └──────────────────────┘                └──────────────────────┘
                             (Group: intent-scorer)                  (Group: purchase-handler)
```

---

## 2. Event Consumers Reference

To support independent scaling, the pipeline is divided into **six dedicated consumer groups** in `@revynta/event-consumer`:

| Consumer Group Name | Subscribed Topic(s) | Target Storage / Output Topic | Partition Strategy | Primary Responsibility |
| :--- | :--- | :--- | :--- | :--- |
| **`ingestion-enricher-group`** | `events.raw` | `events.enriched`, `events.identity`, `events.consent` | Partitioned by `visitorId` (hash) | Validates raw telemetry payload structure. Performs visitor-to-shopper mapping resolving. Parses User-Agent and client IP. Routes events to secondary topics. |
| **`clickhouse-writer-group`** | `events.enriched` | ClickHouse (`events_analytics` table) | Partitioned by `shopperId` (hash) | Gathers and batch-inserts events to ClickHouse using native bulk queries (minimizing database file merges). |
| **`session-processor-group`** | `events.enriched` | Redis Hash & PostgreSQL `sessions` | Partitioned by `sessionId` (hash) | Maintains real-time active session states in Redis with a 45-minute TTL. Syncs `last_active_at` timestamp to PostgreSQL. |
| **`identity-resolver-group`** | `events.identity` | PostgreSQL `shopper_identities` | Partitioned by `shopperId` (hash) | Hashes deterministic identifiers (SHA-256) and encrypts PII (AES-256-GCM) for shopper matching records. |
| **`purchase-handler-group`** | `events.enriched` | Redis key & PostgreSQL conversions | Partitioned by `shopperId` (hash) | Intercepts purchase actions, stores a 24-hour campaign suppression key in Redis, and flags sessions as completed to prevent recovery emails. |
| **`intent-scorer-group`** | `events.enriched` | Redis Hash & PostgreSQL `shoppers` | Partitioned by `shopperId` (hash) | Increments session scores based on actions (e.g. `cart_add` +25, `checkout_init` +50). Persists score/segment in PostgreSQL. |

---

## 3. Reliability and Fault Tolerance

### 3.1. Delivery Guarantees
The pipeline utilizes **at-least-once delivery** combined with **idempotent consumer processing**:
* **Kafka offsets** are only committed after the event has been successfully written to the target database (or sent to the Dead-Letter Queue).
* **ClickHouse** deduplicates events using `uniqMerge` on aggregates, and query-level `event_id` filtering.
* **PostgreSQL** enforces uniqueness via constraints (e.g. `shopper_identities` unique keys, `message_logs` idempotency keys).
* **Redis** writes utilize idempotent sets (`HSET`, `SET`).

### 3.2. Retry & Dead-Letter Queue (DLQ) Topology
* **Retries**: Downstream failures (e.g., ClickHouse connection timeouts) are retried inside the consumer using **exponential backoff** with jitter (default 3 retries, starting at 500ms).
* **DLQ Routing**: If an event fails processing after all retries (or is discovered to be structurally malformed), the consumer catches the error, serializes the failure metadata (timestamp, original payload, error trace), writes it to the `events.deadletter` topic, and resolves the partition offset to prevent blocking other messages.

---

## 4. Canonical Event Schema

All events are formatted under a single event envelope (`BaseEvent` or `EnrichedEvent` defined in `@revynta/shared-types`):
```typescript
interface EnrichedEvent {
  eventId: string;          // Unique UUIDv4 event identifier
  tenantId: string;         // Store ID UUID
  sessionId: string;        // Browser tab session UUID
  shopperId: string;        // Resolved master shopper UUID
  eventType: EventType;     // Telemetry type (page_view, cart_add, purchase)
  eventTime: string;        // ISO 8601 UTC timestamp
  sdkVersion: string;       // Client SDK version
  pageUrl: string;          // Source document location
  referrer?: string;
  userAgent?: string;
  ipAddress?: string;
  country?: string;         
  productId?: string;       // Optional telemetry parameters
  productPrice?: number;
  productCategories?: string[];
  productName?: string;
  query?: string;           // Optional search query
  metadata?: Record<string, any>;
}
```
