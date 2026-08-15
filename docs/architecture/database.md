# Database Architecture Specifications

Revynta implements a hybrid transactional and analytical storage architecture. It splits core business states and telemetry tracking into distinct storage systems to maximize write throughput, reduce operational costs, and guarantee strict tenant isolation.

---

## 1. Relational Transactional Engine: PostgreSQL 16

PostgreSQL serves as the primary system of record for configuration, campaigns, core shopper mappings, permissions, and audit logs.

```
PostgreSQL RLS Transaction Isolation Context:
               ┌────────────────────────┐
               │    SaaS Application    │
               └───────────┬────────────┘
                           │ Transaction boundaries
                           v
               ┌────────────────────────┐
               │ SELECT set_config(     │
               │   'app.current_store_id'│
               │   :store_id, true)     │
               └───────────┬────────────┘
                           │ Sets local session scope
                           v
        ┌──────────────────┴──────────────────┐
        ▼                                     ▼
┌──────────────┐                       ┌──────────────┐
│  Store A     │                       │  Store B     │
│  Shopper RLS │                       │  Shopper RLS │
│  Active      │                       │  Active      │
└──────────────┘                       └──────────────┘
```

### 1.1. Row-Level Security (RLS) Strategy
Multi-tenancy is enforced at the database level using RLS. Table owners and superusers bypass RLS by default. To enforce policies under all contexts (defence-in-depth), every tenant table executes `FORCE ROW LEVEL SECURITY`.

* **Session Context Management**:
  All connection pools run queries within a transaction. At transaction startup, the application sets the tenant session variable using PostgreSQL's `set_config` utility:
  ```sql
  SELECT set_config('app.current_store_id', 'store-uuid-value', true);
  ```
  The third parameter (`is_local = true`) restricts the setting to the current transaction. Once the transaction commits or rolls back, PostgreSQL automatically clears the parameter, preventing session bleed or leakage when the connection is returned to the pool.

* **RLS Policies**:
  * Store-isolated tables (e.g. `shoppers`, `api_keys`, `campaigns`, `message_logs`) check:
    ```sql
    USING (store_id = NULLIF(current_setting('app.current_store_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'true')
    ```
  * Organization-isolated tables (e.g. `stores`, `memberships`) check:
    ```sql
    USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'true')
    ```
  * Admin Bypass: The RLS policy evaluates to true if `app.bypass_rls` is set to `'true'`. This restricted path is utilized exclusively by platform operators under `withAdminContext` blocks.

### 1.2. Principal Indexes and Query Patterns
* **`api_keys` (`store_id`, `status`)**: Optimizes key verification checks during SDK event ingestion.
* **`shopper_identities` (`store_id`, `channel`, `identifier_hash`)**: Speeds up identity matching lookups (e.g., resolving a phone number to a `shopper_id`) during checkout/add-to-cart events.
* **`sessions` (`store_id`, `session_token`)**: Accelerates session activity checks.
* **`message_logs` (`store_id`, `status`)**: Speeds up outbox delivery queues and conversions auditing.

---

## 2. Columnar Telemetry Engine: ClickHouse

ClickHouse stores the immutable high-volume stream of behavioral shopper tracking logs.

```
ClickHouse Streaming & Materialization Pipeline:
┌─────────────────────┐
│    Raw Ingestion    │
└──────────┬──────────┘
           │ Write batch
           v
┌────────────────────────────────────────────────────────┐
│ TABLE: events_analytics (Columnar Raw Logs)             │
│ Primary Key: (tenant_id, event_type, event_time, shop) │
└──────────┬─────────────────────────────────────────────┘
           │ Materialized View trigger
           v
┌────────────────────────────────────────────────────────┐
│ VIEW: daily_analytics_aggregates_mv                    │
│ Computes: uniqState(shopper_id), count()               │
└──────────┬─────────────────────────────────────────────┘
           │ Pre-aggregated write
           v
┌────────────────────────────────────────────────────────┐
│ TABLE: daily_analytics_aggregates                      │
│ Engine: AggregatingMergeTree()                         │
└────────────────────────────────────────────────────────┘
```

### 2.1. Partitioning and Sorting Rationale
The primary event table is defined as:
```sql
ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_time)
PRIMARY KEY (tenant_id, event_type, event_time, shopper_id)
ORDER BY (tenant_id, event_type, event_time, shopper_id)
```
* **Sorting Key**: `tenant_id` is the leading sorting key. Since ClickHouse queries are executed on behalf of a single merchant dashboard, placing `tenant_id` first allows the database to instantly skip irrelevant index granules.
* **Partitioning**: Partitioning by month (`toYYYYMM(event_time)`) allows dropping old partitions (e.g. older than 90 days) in a single metadata operation, avoiding expensive row deletions.

### 2.2. Materialized Aggregations
To prevent scanning billions of raw events when rendering dashboards, we deploy `AggregatingMergeTree` tables.
* **`daily_analytics_aggregates`**: Stores daily pre-aggregated active visitors and event counts.
  * Uses the `uniqState` accumulator to track unique shopper IDs dynamically.
  * Queries select from the aggregated table using `uniqMerge(unique_visitors)` and `sum(event_count)`. Target: dashboard aggregation p95 < 100ms under 50 concurrent queries/sec.

---

## 3. High-Speed Cache: Redis

Redis acts as our volatile state cache and job queue backbone.

* **Rate Limiting**: Stores `rate:{tenant_id}:{ip}` token-bucket keys with short 60s TTLs.
* **API Key Cache**: Stores `apikey:{hash} -> tenantId` mapping. If a key is invalid, it caches `apikey:{hash} -> invalid` for 5 minutes to prevent Postgres database thrashing.
* **Active Session Cache**: Stores active cart items, viewed categories, and real-time intent scores. Expires after 45 minutes of inactivity.
* **Campaign Cooldowns**: Stores suppression flags `cooldown:{tenant_id}:{shopper_id}:{campaign_id}` for the duration of the campaign cooldown period (e.g., 7 days) to prevent duplicate communications.

---

## 4. Shopper Identity Model

Revynta enforces an **explicit identity graph** to keep tracking data separated and compliant:

1. **Anonymous Visitor ID**: Generated by the SDK as a UUID and stored in localStorage (if consent analytics is granted).
2. **Session ID**: Transient identifier generated on tab load and stored in sessionStorage.
3. **Shopper ID**: The unified server-side shopper profile UUID in PostgreSQL `shoppers`.
4. **Shopper Identities**: Stores encrypted identifiers (emails, phone numbers) in `shopper_identities`. The raw identifier is hashed using SHA-256 for deterministic lookups:
   ```
   identifier_hash = SHA256(lowercase(email or phone))
   ```
   The value is stored encrypted using **AES-256-GCM**.
5. **Resolution Rule**: Identities are merged strictly during explicit identify calls (e.g. form entry, login). Merging visitor IDs and shopper profiles operates through transactional registry logs to allow undo/unlink operations.

---

## 5. Consent & Privacy Model

Shopper consents are modeled as granular purposes under `consent_records`:
* **Purposes**: `analytics` (permissions to store cookies and record basic logs), `personalization` (intent calculation and product scoring), `marketing` (permissions to initiate contact).
* **Isolation**: If marketing consent is withdrawn, the corresponding `consent_records` row status is updated to `denied` and the withdrawal timestamp is saved. The campaign execution worker queries this table immediately before dispatching any messages.

---

## 6. Retention Policies

| Data Category | Target Database | Default Retention | Deletion Mechanism |
| :--- | :--- | :--- | :--- |
| **Raw Events** | ClickHouse | 90 Days | Partition Drop (`ALTER TABLE ... DROP PARTITION`) |
| **Daily Aggregates** | ClickHouse | 2 Years | Partition Drop |
| **Outbound Message Logs** | PostgreSQL | 1 Year | Daily partition deletion / cron cleanup |
| **Audit Logs** | PostgreSQL | 3 Years | Soft delete / archiving process |
