# ADR 0003: Event-Driven Telemetry Pipeline with Kafka, Redis, and ClickHouse

## Status
Approved

## Context
Revynta requires a highly scalable, real-time telemetry processing pipeline to ingest browser clickstream events, resolve anonymous shopper profiles, maintain tab sessions, score shopper interest, and write raw logs for analytical reports. 

We need to support:
* High throughput ingestion (Target: ingestion API p95 < 20ms under 5,000 events/sec).
* Fast dashboard aggregation queries (Target: aggregation p95 < 100ms under 50 concurrent queries/sec).
* Session and purchase state cache lookups (Target: p95 < 5ms).
* Strong tenant isolation (PostgreSQL Row-Level Security).
* Clean separation of concerns allowing individual pipeline components to scale independently.

## Decision
We implement a **multi-consumer event-driven microservices pipeline** built on Redpanda/Kafka, Redis, PostgreSQL, and ClickHouse:

1. **Broker Platform**: We choose Redpanda/Kafka as our message backbone. Telemetry event streams are buffered in partitioned topics.
2. **Shared Producer Model**: To avoid exhausting system sockets under high concurrent loads, all worker threads/consumers share a single connection-managed Kafka producer client instance per worker process.
3. **Partition-based Ingestion Routing**:
   * Raw events are published to `events.raw`, partitioned by client browser `visitorId`.
   * Enriched events are routed to `events.enriched`, partitioned by `shopperId`. This ensures all events for a specific shopper are consumed sequentially by a single partition consumer thread, eliminating database race conditions on concurrent profile writes.
4. **ClickHouse Batching**: We reject single-row ClickHouse inserts, which cause disk-merge bottlenecks. Instead, the `analytics-writer` consumer buffers events and utilizes Kafkajs `eachBatch` to write events in bulk (up to 1,000 events or every 1 second).
5. **Redis Fast Cache**: Fast volatile session updates (event counts, page views) and purchase suppression locks (24-hour TTL) are written to Redis, protecting PostgreSQL from heavy operational workloads.

## Consequences
* **Separation of Scaling**: The enrichment consumer, analytics writer, and identity resolver can be scaled independently using Kafka Consumer Group membership.
* **Network Sockets**: Transitioning to a shared connection-managed producer pool resolves connection exhaustion issues during high-volume processing.
* **At-Least-Once Delivery**: Consumers only commit offsets post-database confirmation. Failures are captured and sent to the `events.deadletter` DLQ topic, ensuring no events are dropped silently.
* **Infrastructure Footprint**: Operating Redpanda, ClickHouse, Redis, and Postgres requires proper configuration (e.g. Docker Compose container parameters) for stable local development and production deployments.
