# ADR 0002: PostgreSQL & ClickHouse Hybrid Storage Architecture

## Status
Approved

## Context
Revynta tracks user events (page views, cart additions, search queries) across hundreds of merchant sites. This workload requires:
1. High-volume write throughput (millions of daily events).
2. Low-latency analytical aggregates (conversion funnels, daily visitors) for merchant dashboards.
3. Strict ACID transactions for tenant billing, campaigns, user permissions, and API key lifecycles.
4. Strict multi-tenant isolation.

Storing both workloads in a single database introduces scaling bottlenecks:
* PostgreSQL cannot efficiently perform full-table scans over hundreds of millions of raw event logs without impacting transactional queries.
* Columnar databases (like ClickHouse) are not designed for transactional updates, foreign keys, or complex permission trees.

## Decision
We will implement a hybrid storage architecture:
1. **PostgreSQL 16**: System of record for all transactional SaaS configurations, campaigns, user authentication, customer consent registries, and audit logs. Row-Level Security (RLS) is enabled on all tables.
2. **ClickHouse**: Columnar storage engine dedicated to storing raw behavioral event logs and computing pre-aggregated merchant analytics.

## Rationale
* **Write Performance**: ClickHouse can ingest hundreds of thousands of events per second in bulk using columnar block compression.
* **Storage Optimization**: Columnar compression reduces raw log sizes by 70-90% compared to row-based databases.
* **Dashboard Latency**: ClickHouse's AggregatingMergeTree and Materialized Views target pre-aggregated dashboard metric computations in p95 < 100ms under 50 concurrent queries/sec without scanning raw tables.
* **ACID and Security**: PostgreSQL handles sensitive organization details and customer records with strict relational integrity, foreign key constraints, and connection pooling.

## Alternatives Considered
* **PostgreSQL Only (with TimescaleDB)**:
  * *Pros*: Single database, simplified architecture.
  * *Cons*: Scaling out TimescaleDB requires expensive clustering licenses or complex manual partitioning. Analytical queries under high write load impact core SaaS API speeds.
* **SingleStore**:
  * *Pros*: Single database supporting both row and columnar tables natively.
  * *Cons*: Extremely expensive licensing and high operational complexity.

## Trade-offs & Risks
* **Stitching Queries**: Joined queries (e.g. mapping clickstream events to a campaign's name) must be stitched at the application layer by querying Postgres for metadata and filtering ClickHouse by IDs.
* **Eventual Consistency**: Behavioral logs in ClickHouse are written asynchronously via Kafka consumers. There is a small delay (typically < 1s) before event logs appear in dashboard charts.
* **Event Deduplication**: ClickHouse does not enforce primary key uniqueness constraints on insert. Idempotency must be managed using deduplication tokens (`event_id`) in consumers and queries.
