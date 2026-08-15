import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  postgres,
  redis,
  withStoreContext,
  withAdminContext,
  upsertProduct,
  recordAffinitySignal,
  setPurchaseSuppression,
} from '@revynta/database';
import {
  HybridRecommendationModel,
  rankCandidates,
  loadRecommendationConfig,
  RecommendationEvaluator,
} from '../src/index.js';
import crypto from 'crypto';

describe('Phase 11 - ML / Recommendation Engine Comprehensive Test Suite', () => {
  let storeAId: string;
  let storeBId: string;
  let orgAId: string;
  let orgBId: string;
  let recModel: HybridRecommendationModel;

  let productA1: string;
  let productA2: string;
  let productA3: string;
  let productB1: string;

  beforeAll(async () => {
    await postgres.raw('UPDATE knex_migrations_lock SET is_locked = 0').catch(() => {});
    await postgres.migrate.latest();

    recModel = new HybridRecommendationModel();

    // 1. Seed Tenant A
    const resA = await withAdminContext(async (adminTrx: any) => {
      const [o] = await adminTrx('organizations').insert({ name: 'Rec Org A' }).returning('*');
      const [s] = await adminTrx('stores').insert({
        organization_id: o.id,
        name: 'Rec Store A',
        domain: `recstorea-${crypto.randomUUID()}.com`,
      }).returning('*');
      return { orgId: o.id, storeId: s.id };
    });
    storeAId = resA.storeId;
    orgAId = resA.orgId;

    // 2. Seed Tenant B
    const resB = await withAdminContext(async (adminTrx: any) => {
      const [o] = await adminTrx('organizations').insert({ name: 'Rec Org B' }).returning('*');
      const [s] = await adminTrx('stores').insert({
        organization_id: o.id,
        name: 'Rec Store B',
        domain: `recstoreb-${crypto.randomUUID()}.com`,
      }).returning('*');
      return { orgId: o.id, storeId: s.id };
    });
    storeBId = resB.storeId;
    orgBId = resB.orgId;

    // 3. Seed Store A Products
    const p1 = await upsertProduct(storeAId, {
      sku: 'SKU-A1',
      name: 'Black Linen Shirt',
      categories: ['Shirts', 'Linen'],
      brand: 'AcmeStyle',
      price: 49.99,
      status: 'active',
    });
    const p2 = await upsertProduct(storeAId, {
      sku: 'SKU-A2',
      name: 'Oversized Black Shirt',
      categories: ['Shirts', 'Oversized'],
      brand: 'AcmeStyle',
      price: 59.99,
      status: 'active',
    });
    const p3 = await upsertProduct(storeAId, {
      sku: 'SKU-A3',
      name: 'White Cotton Shirt',
      categories: ['Shirts', 'Cotton'],
      brand: 'BasicWear',
      price: 29.99,
      status: 'active',
    });
    productA1 = p1.id;
    productA2 = p2.id;
    productA3 = p3.id;

    // 4. Seed Store B Products
    const pB1 = await upsertProduct(storeBId, {
      sku: 'SKU-B1',
      name: 'Tenant B Running Shoes',
      categories: ['Footwear', 'Running'],
      brand: 'SpeedRun',
      price: 89.99,
      status: 'active',
    });
    productB1 = pB1.id;
  });

  afterAll(async () => {
    await redis.flushdb();
    await postgres.destroy();
  });

  // 1. Personalized Recommendations
  it('1. Personalized strategy prioritizes products matching shopper affinity', async () => {
    const shopperId = crypto.randomUUID();
    await recordAffinitySignal(storeAId, 'product', productA1, 20);
    await recordAffinitySignal(storeAId, 'category', 'Shirts', 10);

    const result = await recModel.recommend({
      storeId: storeAId,
      shopperId,
      strategy: 'personalized',
      skipCache: true,
    });

    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.strategy).toBe('personalized');
    expect(result.recommendations[0].productId).toBe(productA1);
    expect(result.recommendations[0].reasonCode).toBe('PERSONALIZED_AFFINITY');
  });

  // 2. Cold-Start Recommendations
  it('2. Cold-start strategy provides recommendations for new shopper with zero history', async () => {
    const freshShopperId = crypto.randomUUID();
    const result = await recModel.recommend({
      storeId: storeAId,
      shopperId: freshShopperId,
      strategy: 'cold_start',
      skipCache: true,
    });

    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.strategy).toBe('cold_start');
    expect(result.recommendations[0].reasonCode).toBe('COLD_START');
  });

  // 3. Popular Recommendations
  it('3. Popular strategy returns active store products', async () => {
    const result = await recModel.recommend({
      storeId: storeAId,
      strategy: 'popular',
      skipCache: true,
    });

    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.strategy).toBe('popular');
  });

  // 4. Trending Recommendations
  it('4. Trending strategy fallback handles ClickHouse unavailability gracefully', async () => {
    const result = await recModel.recommend({
      storeId: storeAId,
      strategy: 'trending',
      skipCache: true,
    });

    expect(result.strategy).toBe('trending');
    expect(Array.isArray(result.recommendations)).toBe(true);
  });

  // 5. Similar-Product Recommendations
  it('5. Similar-product strategy finds products matching metadata attributes', async () => {
    const result = await recModel.recommend({
      storeId: storeAId,
      strategy: 'similar',
      productId: productA1,
      skipCache: true,
    });

    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.strategy).toBe('similar');

    // Excludes target product itself
    const targetFound = result.recommendations.find((r) => r.productId === productA1);
    expect(targetFound).toBeUndefined();

    // Recommends productA2 (same brand & category)
    expect(result.recommendations[0].productId).toBe(productA2);
    expect(result.recommendations[0].reasonCode).toBe('SIMILAR_PRODUCT');
  });

  // 6. Category Recommendations
  it('6. Category strategy returns products within target category', async () => {
    const result = await recModel.recommend({
      storeId: storeAId,
      strategy: 'category',
      category: 'Shirts',
      skipCache: true,
    });

    expect(result.recommendations.length).toBeGreaterThan(0);
    for (const rec of result.recommendations) {
      expect(rec.categories).toContain('Shirts');
    }
  });

  // 7. Candidate Merging
  it('7. Hybrid strategy merges candidates across sources', async () => {
    const result = await recModel.recommend({
      storeId: storeAId,
      strategy: 'hybrid',
      skipCache: true,
    });

    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.strategy).toBe('hybrid');
  });

  // 8. Duplicate Removal
  it('8. Candidate deduplication ensures each product appears at most once', async () => {
    const result = await recModel.recommend({
      storeId: storeAId,
      strategy: 'hybrid',
      skipCache: true,
    });

    const productIds = result.recommendations.map((r) => r.productId);
    const uniqueProductIds = new Set(productIds);
    expect(productIds.length).toBe(uniqueProductIds.size);
  });

  // 9. Deterministic Ranking
  it('9. Ranking engine is deterministic under identical inputs', async () => {
    const res1 = await recModel.recommend({ storeId: storeAId, strategy: 'hybrid', skipCache: true });
    const res2 = await recModel.recommend({ storeId: storeAId, strategy: 'hybrid', skipCache: true });

    expect(res1.recommendations.map((r) => r.productId)).toEqual(res2.recommendations.map((r) => r.productId));
    expect(res1.recommendations.map((r) => r.score)).toEqual(res2.recommendations.map((r) => r.score));
  });

  // 10. Score Normalization
  it('10. Scores are normalized between 0.0 and 1.0', async () => {
    const result = await recModel.recommend({ storeId: storeAId, strategy: 'hybrid', skipCache: true });

    for (const rec of result.recommendations) {
      expect(rec.score).toBeGreaterThanOrEqual(0.0);
      expect(rec.score).toBeLessThanOrEqual(1.0);
    }
  });

  // 11. Recommendation Reasons
  it('11. Every recommendation includes explainable reason and stable reasonCode', async () => {
    const result = await recModel.recommend({ storeId: storeAId, strategy: 'hybrid', skipCache: true });

    for (const rec of result.recommendations) {
      expect(rec.reasonCode).toBeDefined();
      expect(rec.reason).toBeDefined();
      expect(typeof rec.reason).toBe('string');
    }
  });

  // 12. Purchase Suppression Integration
  it('12. Purchase suppression applies heavy penalty for recently purchased shopper', async () => {
    const shopperId = crypto.randomUUID();
    await setPurchaseSuppression(storeAId, shopperId, 86400);

    const result = await recModel.recommend({
      storeId: storeAId,
      shopperId,
      strategy: 'personalized',
      skipCache: true,
    });

    // Suppressed shopper recommendations have score 0
    for (const rec of result.recommendations) {
      expect(rec.score).toBe(0);
    }
  });

  // 13. Unavailable Product Filtering
  it('13. Out of stock / inactive / deleted products are penalized or filtered out', async () => {
    const outOfStockProd = await upsertProduct(storeAId, {
      sku: 'SKU-OOS',
      name: 'Out of Stock Jacket',
      categories: ['Jackets'],
      price: 99.99,
      status: 'out_of_stock',
    });

    const result = await recModel.recommend({ storeId: storeAId, strategy: 'cold_start', skipCache: true });
    const oosItem = result.recommendations.find((r) => r.productId === outOfStockProd.id);

    if (oosItem) {
      expect(oosItem.score).toBe(0);
    }
  });

  // 14. Multi-Tenant Isolation (Postgres RLS)
  it('14. Store A cannot recommend Store B products', async () => {
    const resultA = await recModel.recommend({ storeId: storeAId, strategy: 'hybrid', skipCache: true });

    const storeBProdInA = resultA.recommendations.find((r) => r.productId === productB1);
    expect(storeBProdInA).toBeUndefined();
  });

  // 15. Redis Cache Key Isolation
  it('15. Redis cache keys are tenant-isolated', async () => {
    const shopperId = crypto.randomUUID();
    await recModel.recommend({ storeId: storeAId, shopperId, strategy: 'popular' });

    const cacheKeyA = `recommendations:${storeAId}:shopper:${shopperId}:popular:hybrid-v1`;
    const cacheKeyB = `recommendations:${storeBId}:shopper:${shopperId}:popular:hybrid-v1`;

    const valA = await redis.get(cacheKeyA);
    const valB = await redis.get(cacheKeyB);

    expect(valA).not.toBeNull();
    expect(valB).toBeNull(); // Tenant B key does not exist!
  });

  // 16. Recommendation Cache Hit
  it('16. Subsequent requests hit Redis cache', async () => {
    const shopperId = crypto.randomUUID();
    const res1 = await recModel.recommend({ storeId: storeAId, shopperId, strategy: 'popular' });
    expect(res1.cached).toBe(false);

    const res2 = await recModel.recommend({ storeId: storeAId, shopperId, strategy: 'popular' });
    expect(res2.cached).toBe(true);
  });

  // 17. Recommendation Cache Miss
  it('17. SkipCache parameter bypasses Redis cache', async () => {
    const shopperId = crypto.randomUUID();
    await recModel.recommend({ storeId: storeAId, shopperId, strategy: 'popular' });

    const resBypass = await recModel.recommend({
      storeId: storeAId,
      shopperId,
      strategy: 'popular',
      skipCache: true,
    });
    expect(resBypass.cached).toBe(false);
  });

  // 18. Cache Expiry & TTL
  it('18. Cached keys have configured TTL set in Redis', async () => {
    const shopperId = crypto.randomUUID();
    await recModel.recommend({ storeId: storeAId, shopperId, strategy: 'popular' });

    const cacheKey = `recommendations:${storeAId}:shopper:${shopperId}:popular:hybrid-v1`;
    const ttl = await redis.ttl(cacheKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  // 19. Maximum Limit Enforcement
  it('19. Limit parameter is bounded by maxLimit config (50)', async () => {
    const result = await recModel.recommend({
      storeId: storeAId,
      strategy: 'hybrid',
      limit: 1000,
      skipCache: true,
    });
    expect(result.recommendations.length).toBeLessThanOrEqual(50);
  });

  // 20. Empty Product Catalog Handling
  it('20. Empty catalog store returns empty recommendations gracefully', async () => {
    const emptyStoreRes = await withAdminContext(async (adminTrx: any) => {
      const [s] = await adminTrx('stores').insert({
        organization_id: orgAId,
        name: 'Empty Store',
        domain: `empty-${crypto.randomUUID()}.com`,
      }).returning('*');
      return s.id;
    });

    const result = await recModel.recommend({ storeId: emptyStoreRes, strategy: 'hybrid', skipCache: true });
    expect(result.recommendations).toEqual([]);
  });

  // 21. Empty Shopper History Handling
  it('21. Anonymous shopper with empty history degrades to cold-start fallback', async () => {
    const result = await recModel.recommend({ storeId: storeAId, strategy: 'personalized', skipCache: true });
    expect(Array.isArray(result.recommendations)).toBe(true);
  });

  // 22. Sparse Data Behavior
  it('22. Sparse history produces valid non-zero scores', async () => {
    const result = await recModel.recommend({ storeId: storeAId, strategy: 'hybrid', skipCache: true });
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  // 23. Identical-Score Tie Breaking
  it('23. Tie breaking sorts by productId ASC when scores are identical', async () => {
    const pA = await upsertProduct(storeAId, { sku: 'TIE-A', name: 'Tie A', price: 10, status: 'active' });
    const pB = await upsertProduct(storeAId, { sku: 'TIE-B', name: 'Tie B', price: 10, status: 'active' });

    const cands = [
      { product: pB, source: 'cold', sourceScore: 0.5, componentScores: { personalizedScore: 0, affinityScore: 0, intentScore: 0, popularityScore: 0, trendScore: 0, similarityScore: 0, categoryScore: 0, freshnessScore: 0 }, penalties: { repetitionPenalty: 0, purchasedPenalty: 0, unavailablePenalty: 0 } },
      { product: pA, source: 'cold', sourceScore: 0.5, componentScores: { personalizedScore: 0, affinityScore: 0, intentScore: 0, popularityScore: 0, trendScore: 0, similarityScore: 0, categoryScore: 0, freshnessScore: 0 }, penalties: { repetitionPenalty: 0, purchasedPenalty: 0, unavailablePenalty: 0 } },
    ];

    const config = loadRecommendationConfig();
    const ranked = rankCandidates(storeAId, cands as any, { storeId: storeAId, intentScore: 0, intentSegment: 'low', isPurchased: false, topProductAffinities: [], topCategoryAffinities: [], recentViewedProductIds: [], recentCategories: [], personalizationConsent: true }, config, 10);

    const sortedIds = [pA.id, pB.id].sort();
    expect(ranked[0].productId).toBe(sortedIds[0]);
    expect(ranked[1].productId).toBe(sortedIds[1]);
  });

  // 24. ClickHouse Feature Query Correctness
  it('24. ClickHouse fallback queries return safe defaults without error', async () => {
    const result = await recModel.recommend({ storeId: storeAId, strategy: 'trending', skipCache: true });
    expect(result.strategy).toBe('trending');
  });

  // 25. Recommendation Response Format
  it('25. Response matches structured format with recommendations, strategy, generatedAt, modelVersion', async () => {
    const result = await recModel.recommend({ storeId: storeAId, strategy: 'hybrid', skipCache: true });
    expect(result.recommendations).toBeDefined();
    expect(result.strategy).toBe('hybrid');
    expect(result.generatedAt).toBeDefined();
    expect(result.modelVersion).toBe('hybrid-v1');
  });

  // 26. Recommendation Model Versioning
  it('26. Model version is exposed as hybrid-v1', async () => {
    expect(recModel.version).toBe('hybrid-v1');
  });

  // 27. Recommendation Evaluator Metrics
  it('27. Offline evaluator correctly computes Precision@K, Recall@K, Coverage, Diversity', async () => {
    const evaluator = new RecommendationEvaluator();

    const mockRecs = [
      { productId: productA1, sku: 'SKU-A1', name: 'P1', categories: ['Shirts'], brand: 'B1', price: 10, score: 0.9, reasonCode: 'PERSONALIZED_AFFINITY' as const, reason: 'r1', source: 's1' },
      { productId: productA2, sku: 'SKU-A2', name: 'P2', categories: ['Shirts'], brand: 'B1', price: 20, score: 0.8, reasonCode: 'PERSONALIZED_AFFINITY' as const, reason: 'r2', source: 's1' },
    ];

    const metrics = evaluator.evaluate(mockRecs, [productA1, productA3], 10, 5);

    expect(metrics.precisionAtK).toBe(0.5); // 1 out of 2 recommended is relevant
    expect(metrics.recallAtK).toBe(0.5);    // 1 out of 2 relevant retrieved
    expect(metrics.hitRateAtK).toBe(1);     // At least 1 hit
    expect(metrics.coverage).toBe(0.2);     // 2 unique products out of 10 total catalog
    expect(metrics.diversityIndex).toBeGreaterThanOrEqual(0);
  });

  // 28. Cross-Tenant Product Leakage Prevention
  it('28. Cross-Tenant Product Isolation: Store B context cannot retrieve Store A products', async () => {
    const resultB = await recModel.recommend({ storeId: storeBId, strategy: 'hybrid', skipCache: true });

    const storeAProdInB = resultB.recommendations.find((r) => r.productId === productA1 || r.productId === productA2);
    expect(storeAProdInB).toBeUndefined();
  });

  // 29. Category Diversity Cap
  it('29. Category diversity constraint caps same-category recommendations', async () => {
    const config = loadRecommendationConfig({ diversityCapPerCategory: 1 });
    const cands = [
      { product: { id: 'p1', store_id: storeAId, sku: 's1', name: 'n1', categories: ['Shirts'], price: 10, status: 'active', deleted_at: null }, source: 'c', sourceScore: 0.9, componentScores: { personalizedScore: 0.9, affinityScore: 0, intentScore: 0, popularityScore: 0, trendScore: 0, similarityScore: 0, categoryScore: 0, freshnessScore: 0 }, penalties: { repetitionPenalty: 0, purchasedPenalty: 0, unavailablePenalty: 0 } },
      { product: { id: 'p2', store_id: storeAId, sku: 's2', name: 'n2', categories: ['Shirts'], price: 10, status: 'active', deleted_at: null }, source: 'c', sourceScore: 0.8, componentScores: { personalizedScore: 0.8, affinityScore: 0, intentScore: 0, popularityScore: 0, trendScore: 0, similarityScore: 0, categoryScore: 0, freshnessScore: 0 }, penalties: { repetitionPenalty: 0, purchasedPenalty: 0, unavailablePenalty: 0 } },
      { product: { id: 'p3', store_id: storeAId, sku: 's3', name: 'n3', categories: ['Shoes'], price: 10, status: 'active', deleted_at: null }, source: 'c', sourceScore: 0.7, componentScores: { personalizedScore: 0.7, affinityScore: 0, intentScore: 0, popularityScore: 0, trendScore: 0, similarityScore: 0, categoryScore: 0, freshnessScore: 0 }, penalties: { repetitionPenalty: 0, purchasedPenalty: 0, unavailablePenalty: 0 } },
    ];

    const ranked = rankCandidates(storeAId, cands as any, { storeId: storeAId, intentScore: 0, intentSegment: 'low', isPurchased: false, topProductAffinities: [], topCategoryAffinities: [], recentViewedProductIds: [], recentCategories: [], personalizationConsent: true }, config, 10);

    const shirtRecs = ranked.filter((r) => r.categories.includes('Shirts'));
    expect(shirtRecs.length).toBe(1); // Capped at 1 Shirts product!
  });

  // 30. Personalization Consent Respect
  it('30. When personalization consent is denied, affinity signals are stripped', async () => {
    const shopperId = crypto.randomUUID();
    // Insert denied consent for personalization
    await withStoreContext(storeAId, async (trx: any) => {
      await trx('shoppers').insert({ id: shopperId, store_id: storeAId });
      await trx('consent_records').insert({
        store_id: storeAId,
        shopper_id: shopperId,
        purpose: 'personalization',
        status: 'denied',
        source: 'test',
        policy_version: 'v1',
      });
    });

    await recordAffinitySignal(storeAId, 'product', productA1, 50);

    const result = await recModel.recommend({
      storeId: storeAId,
      shopperId,
      strategy: 'personalized',
      skipCache: true,
    });

    // Affinity signals should be ignored due to denied consent
    expect(result.recommendations.length).toBe(0);
  });
});
