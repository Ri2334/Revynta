# ADR-007: Explainable Deterministic Intent Engine Architecture

## Status
Accepted

## Context
Revynta requires an intelligent, multi-tenant shopper intent platform that evaluates real-time shopper signals (page views, product views, category browsing, searches, cart additions, and checkout initiations) to calculate live intent scores, rank shopper segments (low, medium, high), track affinity across dimensions, and provide explainable factor breakdowns for merchants.

Rather than jumping straight to complex ML/LLM models, Revynta requires an explainable, deterministic scoring model as the v1 intelligence foundation, while establishing interfaces (`IntentModel`) so ML models can seamlessly plug in later without rewriting the event pipeline.

## Decision
1. **Model Implementation**:
   - Implement `HeuristicIntentModel` complying with `IntentModel` interface.
   - Use configurable weights for positive and negative behavioral signals (`config/intent_config.json`).
   - Implement exponential recency decay ($\text{Weight} \times 0.5^{\frac{\Delta t}{T_{1/2}}}$) with half-lives per signal type (24h search, 48h product/cart).

2. **Redis & PostgreSQL Separation**:
   - **Redis**: Hot ephemeral session state (`HASH`), bounded affinity scores (`ZSET`), and fast purchase suppression circuit breaker.
   - **PostgreSQL**: Authoritative durable shopper intent (`shopper_intent`), RLS multi-tenant isolated profile records, purchase suppression fallback (`purchase_suppression`).

3. **Purchase Suppression & Circuit Breaker**:
   - Purchase transitions session to `purchase_completed = true`.
   - Redis key `purchased_recently:{tenantId}:{shopperId}` set with 24h TTL.
   - PostgreSQL `purchase_suppression` table updated durably.
   - Intent score reset to 0 to prevent recovery target overlap.

4. **Model Versioning**:
   - Tag all intent evaluation results and DB records with `model_version: "v1"`.

## Consequences
- Clean abstraction allowing future transition from `HeuristicIntentModel` to `MLIntentModel`.
- High-throughput execution (>600 events/sec local pipeline processing).
- Fully explainable top-5 signal factor breakdown for merchant dashboards.
- Durable purchase suppression preventing unwanted campaign targeting.
