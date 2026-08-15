# ADR-011: Hybrid Recommendation Engine Architecture

## Status
Accepted

## Context
Revynta requires an intelligent product recommendation system to allow merchants to present personalized, similar, trending, popular, category-aware, and cold-start product recommendations to shoppers across web and messaging channels (WhatsApp).

Key requirements:
- Multi-tenant RLS isolation (no cross-tenant product or behavioral signal leakage).
- Explainable, deterministic ranking (no black-box unexplainable AI).
- Operational for zero-history cold-start shoppers as well as high-intent returning shoppers.
- High performance (Redis caching, ClickHouse behavioral aggregates).
- Privacy/consent aware (respects Phase 5 personalization opt-out).
- Pluggable architecture allowing future ML/vector models without API contract changes.

## Decisions

### 1. Hybrid Recommendation Architecture
- Adopt a multi-source candidate generation architecture (Personalized, Similar, Trending, Popular, Category, Cold Start) combined by a deterministic ranking engine.
- Rationale: Production recommendation systems must degrade gracefully. Relying on a single heavy AI model causes fragility under sparse data or service outages. A hybrid heuristic ranker guarantees high availability and zero cold-start failures.

### 2. Weighted Composite Ranking Formula & Deterministic Tie-Breaking
- Component scores are normalized to $[0.0, 1.0]$ and combined:
  $$\text{FinalScore} = \sum (w_i \cdot S_i) - P_{\text{purchased}} - P_{\text{unavailable}} - P_{\text{repetition}}$$
- Ties are broken deterministically by sorting `score DESC`, then `productId ASC`. This ensures 100% reproducible rankings for testing, debugging, and auditing.

### 3. ClickHouse Behavioral Aggregation
- Recency-weighted trending, overall popularity, and session co-interaction (collaborative signal) queries run against ClickHouse `events_analytics`.
- All ClickHouse queries use parameterized `{tenantId:UUID}` filters to prevent SQL injection and cross-tenant data leakage.

### 4. Redis Recommendation Caching
- Recommendations are cached in Redis under tenant-isolated keys (`recommendations:{storeId}:{entityType}:{entityId}:{strategy}:{version}`) with a 5-minute TTL.
- Cache bypass (`skipCache=true`) is supported for real-time testing and immediate behavioral updates.

### 5. Purchase Suppression & Consent Integration
- Reuses Phase 7's authoritative purchase suppression circuit breaker (`isPurchaseSuppressed`) to apply a max penalty ($1.0$) to recently purchased products.
- Checks Phase 5 consent records (`ConsentState.personalization`). If personalization is denied, affinity signals are stripped.

### 6. Decoupled Model Abstraction
- The engine implements a clean `RecommendationModel` interface (`HybridRecommendationModel`).
- Future machine learning algorithms (collaborative filtering, matrix factorization, vector embeddings, gradient-boosted rankers) can implement the `RecommendationModel` interface without changing API routes or data schemas.

## Alternatives Considered

- **External LLM/Embedding API (OpenAI / Pinecone)**: Rejected for Phase 11. Introduces external network latency, recurring API costs, vendor lock-in, and unpredictable latency spikes. A local hybrid deterministic ranker provides instant sub-10ms responses and zero external dependencies.
- **Pure Collaborative Filtering**: Rejected as a single strategy due to severe cold-start limitations for new stores or new shoppers with zero interaction history.
- **Global Cross-Tenant Popularity**: Rejected. Violates Revynta's strict multi-tenant SaaS isolation guarantees.

## Testing & Verification
- 30 integration tests in `packages/recommendation-engine/test/recommendation_engine.test.ts`.
- Tests cover multi-tenant PostgreSQL RLS isolation, Redis cache isolation, candidate merging, score normalization, tie-breaking, purchase suppression, consent opt-out, cold-start fallback, and offline evaluation metrics.
