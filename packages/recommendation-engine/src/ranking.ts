import { ProductRecord } from '@revynta/database';
import { RecommendationReasonCode, RecommendationItem } from '@revynta/shared-types';
import { RecommendationCandidate, RecommendationConfig, ShopperFeatures } from './types.js';

export function rankCandidates(
  storeId: string,
  candidates: RecommendationCandidate[],
  features: ShopperFeatures,
  config: RecommendationConfig,
  limit: number = 10
): RecommendationItem[] {
  if (!candidates || candidates.length === 0) return [];

  // 1. Deduplicate candidates by productId, keeping max component scores
  const mergedMap = new Map<string, RecommendationCandidate>();

  for (const cand of candidates) {
    const pId = cand.product.id;
    // Security / Business Filter 1: Strictly enforce tenant alignment
    if (cand.product.store_id !== storeId) continue;
    // Business Filter 2: Strictly exclude non-active or deleted products
    if (cand.product.status !== 'active' || cand.product.deleted_at) continue;

    if (!mergedMap.has(pId)) {
      mergedMap.set(pId, { ...cand });
    } else {
      const existing = mergedMap.get(pId)!;
      // Merge component scores taking maximums
      existing.componentScores.personalizedScore = Math.max(
        existing.componentScores.personalizedScore,
        cand.componentScores.personalizedScore
      );
      existing.componentScores.affinityScore = Math.max(
        existing.componentScores.affinityScore,
        cand.componentScores.affinityScore
      );
      existing.componentScores.intentScore = Math.max(
        existing.componentScores.intentScore,
        cand.componentScores.intentScore
      );
      existing.componentScores.popularityScore = Math.max(
        existing.componentScores.popularityScore,
        cand.componentScores.popularityScore
      );
      existing.componentScores.trendScore = Math.max(
        existing.componentScores.trendScore,
        cand.componentScores.trendScore
      );
      existing.componentScores.similarityScore = Math.max(
        existing.componentScores.similarityScore,
        cand.componentScores.similarityScore
      );
      existing.componentScores.categoryScore = Math.max(
        existing.componentScores.categoryScore,
        cand.componentScores.categoryScore
      );
      existing.componentScores.freshnessScore = Math.max(
        existing.componentScores.freshnessScore,
        cand.componentScores.freshnessScore
      );
    }
  }

  const uniqueCandidates = Array.from(mergedMap.values());
  const scoredItems: Array<{ candidate: RecommendationCandidate; finalScore: number }> = [];

  // 2. Score each candidate using the weighted composite formula & penalties
  for (const cand of uniqueCandidates) {
    const { componentScores } = cand;
    const { weights, penalties } = config;

    let score =
      weights.personalized * componentScores.personalizedScore +
      weights.affinity * componentScores.affinityScore +
      weights.intent * componentScores.intentScore +
      weights.popularity * componentScores.popularityScore +
      weights.trend * componentScores.trendScore +
      weights.similarity * componentScores.similarityScore +
      weights.category * componentScores.categoryScore +
      weights.freshness * componentScores.freshnessScore;

    // Business Filter 3 / Penalty 1: Purchase suppression
    if (features.isPurchased) {
      score -= penalties.purchased;
    }

    // Business Filter 4 / Penalty 2: Out of stock or inactive status
    if (cand.product.status === 'out_of_stock' || cand.product.status === 'inactive') {
      score -= penalties.unavailable;
    }

    // Repetition penalty for recently viewed products
    if (features.recentViewedProductIds.includes(cand.product.id)) {
      score -= penalties.repetition;
    }

    // Clamp score to [0, 1]
    const finalScore = Math.max(0, Math.min(1.0, parseFloat(score.toFixed(4))));
    scoredItems.push({ candidate: cand, finalScore });
  }

  // 3. Deterministic Sorting: score DESC, tie-broken by productId ASC
  scoredItems.sort((a, b) => {
    if (Math.abs(b.finalScore - a.finalScore) > 0.0001) {
      return b.finalScore - a.finalScore;
    }
    return a.candidate.product.id.localeCompare(b.candidate.product.id);
  });

  // 4. Category Diversity Enforcer
  const categoryCounts = new Map<string, number>();
  const diverseItems: typeof scoredItems = [];

  for (const item of scoredItems) {
    const cats = item.candidate.product.categories;
    const primaryCat = cats.length > 0 ? cats[0].toLowerCase() : 'uncategorized';

    const currentCount = categoryCounts.get(primaryCat) || 0;
    if (currentCount < config.diversityCapPerCategory) {
      categoryCounts.set(primaryCat, currentCount + 1);
      diverseItems.push(item);
    }
  }

  // 5. Slice to top K limit and map to explainable RecommendationItem format
  const finalLimit = Math.min(limit, config.maxLimit);
  return diverseItems.slice(0, finalLimit).map((item) => {
    const { product, source } = item.candidate;
    const { reasonCode, reason } = deriveExplainableReason(item.candidate, features);

    return {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      categories: product.categories,
      brand: product.brand,
      price: product.price,
      score: item.finalScore,
      reasonCode,
      reason,
      source,
      metadata: product.metadata,
    };
  });
}

/**
 * Derives stable reasonCode and human-readable reason text from top candidate component scores
 */
function deriveExplainableReason(
  candidate: RecommendationCandidate,
  features: ShopperFeatures
): { reasonCode: RecommendationReasonCode; reason: string } {
  const { componentScores } = candidate;

  if (componentScores.similarityScore >= 0.4) {
    return {
      reasonCode: 'SIMILAR_PRODUCT',
      reason: 'Similar to products you have interacted with',
    };
  }

  if (componentScores.personalizedScore >= 0.4 || componentScores.affinityScore >= 0.4) {
    return {
      reasonCode: 'PERSONALIZED_AFFINITY',
      reason: 'Recommended based on your shopping preferences',
    };
  }

  if (componentScores.categoryScore >= 0.4) {
    const primaryCat = candidate.product.categories[0] || 'this category';
    return {
      reasonCode: 'CATEGORY_AFFINITY',
      reason: `Popular in ${primaryCat}`,
    };
  }

  if (componentScores.trendScore >= 0.4) {
    return {
      reasonCode: 'TRENDING_STORE',
      reason: 'Trending in this store',
    };
  }

  if (candidate.source === 'cold_start' && componentScores.personalizedScore === 0) {
    return {
      reasonCode: 'COLD_START',
      reason: 'Popular in this store',
    };
  }

  if (componentScores.popularityScore >= 0.3) {
    return {
      reasonCode: 'POPULAR_STORE',
      reason: 'Popular in this store',
    };
  }

  return {
    reasonCode: 'COLD_START',
    reason: 'Top choice in this store',
  };
}
