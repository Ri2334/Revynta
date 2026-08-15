# Revynta Intent Engine & Session Cache Architecture

## 1. Overview
The Intent Engine is Revynta's real-time shopper behavioral intelligence layer. It tracks live visitor interaction signals (page views, product views, category browsing, cart additions, search queries, and checkout initiations) to calculate real-time intent scores (0–100), classify shopper segments (low, medium, high), maintain affinity profiles across multiple dimensions, and provide explainable factor breakdowns.

---

## 2. Real-Time Data Flow & Storage Responsibilities

```
                                  +---------------------+
                                  |   Tracking SDK      |
                                  +----------+----------+
                                             |
                                             v
                                  +----------+----------+
                                  |   Ingestion API     |
                                  +----------+----------+
                                             |
                                             v (events.raw)
                                  +----------+----------+
                                  | Raw Enricher Worker |
                                  +----------+----------+
                                             |
                                             v (events.enriched)
                   +-------------------------+-------------------------+
                   |                                                   |
                   v                                                   v
       +-----------+-----------+                           +-----------+-----------+
       | Analytics Writer      |                           | Session & Intent Scorer   |
       +-----------+-----------+                           +-----------+-----------+
                   |                                                   |
                   v                                                   v
       +-----------+-----------+                           +-----------+-----------+
       |   ClickHouse DB       |                           |  Redis Session Cache      |
       | (Historical Analytics)|                           | (Hot Ephemeral State)     |
       +-----------------------+                           +-----------+---------------+
                                                                       |
                                                                       v (flush/ttl)
                                                           +-----------+---------------+
                                                           |   PostgreSQL Database     |
                                                           | (Durable Shopper Intent)  |
                                                           +---------------------------+
```

| Data Store | Purpose & Scope | Data Structures |
|---|---|---|
| **Redis** | Hot, short-lived session state, active intent scores, bounded affinity rankings, and fast purchase suppression circuit breaker. | `HASH` (session state & signals), `ZSET` (capped affinity rankings), `SET` (idempotency keys). |
| **PostgreSQL** | Durable transactional store, authoritative shopper intent history, RLS multi-tenant isolated profile records, purchase suppression fallback. | `shopper_intent`, `purchase_suppression`, `shoppers`, `sessions`, `event_dedup`. |
| **ClickHouse** | High-throughput analytical store for historical event reporting, aggregate trend analysis, and model training data. | `events_analytics`, materialized views. |

---

## 3. Redis Data Structures & Key Naming Convention

All Redis keys enforce tenant isolation using namespaced prefixes:

1. **Session Hash**: `session:{tenantId}:{sessionId}`
   - Fields: `shopper_id`, `last_activity_at`, `last_event_timestamp`, `event_count`, `page_views`, `product_views`, `cart_adds`, `checkout_initiations`, `signals_json`, `intent_score`, `intent_segment`, `intent_explanations`, `model_version`, `purchase_completed`.
   - Expiration: Configurable inactivity TTL (default 45 minutes).

2. **Affinity Capped Sorted Sets (ZSET)**: `affinity:{dimension}:{tenantId}`
   - Dimensions: `product`, `category`, `brand`, `price`, `attribute`.
   - Score: Cumulative weight sum per item. Capped at 200 items per dimension via `zremrangebyrank`.

3. **Purchase Suppression Key**: `purchased_recently:{tenantId}:{shopperId}`
   - String key set to `'true'` with a 24-hour TTL upon purchase conversion.

4. **Idempotency Key**: `processed_event:{consumerGroup}:{eventId}`
   - String key set with 5-minute TTL (`EX 300 NX`) to block duplicate Kafka messages.

---

## 4. Intent Scoring & Exponential Recency Decay

### Score Formula
$$\text{Score} = \min\left(100, \max\left(0, \sum_{i=1}^{N} \text{Weight}_i \times 0.5^{\frac{\Delta t_i}{T_{1/2}}}\right)\right)$$

Where:
- $\text{Weight}_i$: Base weight for signal $i$ (e.g., product view = +5, repeat product view = +10, cart add = +25, checkout init = +50).
- $\Delta t_i$: Elapsed time in hours since signal $i$ occurred.
- $T_{1/2}$: Half-life decay parameter (e.g., 24 hours for search signals, 48 hours for product view & cart signals).

### Segmentation Thresholds
- **Low Intent**: Score 0 – 29
- **Medium Intent**: Score 30 – 69
- **High Intent**: Score 70 – 100

---

## 5. Purchase Suppression Circuit Breaker
When a `purchase` event occurs:
1. Session status `purchase_completed` is set to `'true'` in Redis.
2. Redis suppression key `purchased_recently:{tenantId}:{shopperId}` is set with a 24-hour TTL.
3. Durable record is written to PostgreSQL `purchase_suppression` table.
4. Active intent score in Redis & PostgreSQL is reset to `0` (`low` segment).

---

## 6. Multi-Tenant Isolation & Identity Security
- **Redis Isolation**: All Redis keys include `{tenantId}`. Cross-tenant access is structurally impossible due to key partitioning.
- **PostgreSQL Isolation**: All queries enforce Row-Level Security (RLS) via `withStoreContext(storeId)`.
- **Identity Resolution**: Unverified identities trigger audit logs and separate shopper profiles without destructive auto-merging.
