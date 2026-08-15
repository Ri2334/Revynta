import {
  getActiveProducts,
  getProductsByIds,
  getProductById,
  getTrendingProductsFromCH,
  getPopularProductsFromCH,
  getCoOccurrenceProductsFromCH,
  ProductRecord,
} from '@revynta/database';
import { RecommendationCandidate, RecommendationCandidateSource, ShopperFeatures } from '../types.js';

function createCandidate(
  product: ProductRecord,
  source: string,
  sourceScore: number,
  componentScoresPartial?: Partial<RecommendationCandidate['componentScores']>,
  penaltiesPartial?: Partial<RecommendationCandidate['penalties']>
): RecommendationCandidate {
  return {
    product,
    source,
    sourceScore,
    componentScores: {
      personalizedScore: 0,
      affinityScore: 0,
      intentScore: 0,
      popularityScore: 0,
      trendScore: 0,
      similarityScore: 0,
      categoryScore: 0,
      freshnessScore: 0,
      ...componentScoresPartial,
    },
    penalties: {
      repetitionPenalty: 0,
      purchasedPenalty: 0,
      unavailablePenalty: 0,
      ...penaltiesPartial,
    },
  };
}

/**
 * 1. Personalized Candidate Source (Affinity + Recent Views)
 */
export class PersonalizedCandidateSource implements RecommendationCandidateSource {
  public readonly name = 'personalized';

  public async generateCandidates(
    storeId: string,
    features: ShopperFeatures
  ): Promise<RecommendationCandidate[]> {
    if (!features.personalizationConsent) return [];

    const productIdsToFetch = new Set<string>();
    features.topProductAffinities.forEach((a) => productIdsToFetch.add(a.member));
    features.recentViewedProductIds.forEach((id) => productIdsToFetch.add(id));

    if (productIdsToFetch.size === 0) return [];

    const products = await getProductsByIds(storeId, Array.from(productIdsToFetch));
    const candidates: RecommendationCandidate[] = [];

    for (const product of products) {
      const aff = features.topProductAffinities.find((a) => a.member === product.id);
      const affScore = aff ? Math.min(1.0, aff.score / 50.0) : 0;
      const isRecent = features.recentViewedProductIds.includes(product.id);
      const recencyScore = isRecent ? 0.8 : 0;

      const personalizedScore = Math.max(affScore, recencyScore);

      candidates.push(
        createCandidate(product, this.name, personalizedScore, {
          personalizedScore,
          affinityScore: affScore,
          intentScore: features.intentScore / 100.0,
        })
      );
    }

    return candidates;
  }
}

/**
 * 2. Similar Product Candidate Source (Metadata Similarity + ClickHouse Co-occurrence)
 */
export class SimilarProductCandidateSource implements RecommendationCandidateSource {
  public readonly name = 'similar';

  public async generateCandidates(
    storeId: string,
    features: ShopperFeatures,
    options?: { productId?: string; limit?: number }
  ): Promise<RecommendationCandidate[]> {
    if (!options?.productId) return [];

    const target = await getProductById(storeId, options.productId);
    if (!target) return [];

    const candidatesMap = new Map<string, RecommendationCandidate>();

    // A. Fetch co-occurrence products from ClickHouse (collaborative similarity signal)
    const coOccurring = await getCoOccurrenceProductsFromCH(storeId, options.productId, options?.limit || 10);
    if (coOccurring.length > 0) {
      const coIds = coOccurring.map((c) => c.productId);
      const coProducts = await getProductsByIds(storeId, coIds);
      const maxScore = Math.max(...coOccurring.map((c) => c.score), 1);

      for (const prod of coProducts) {
        if (prod.id === target.id) continue;
        const match = coOccurring.find((c) => c.productId === prod.id);
        const normScore = match ? match.score / maxScore : 0.5;

        candidatesMap.set(
          prod.id,
          createCandidate(prod, this.name, normScore, {
            similarityScore: normScore,
          })
        );
      }
    }

    // B. Fetch metadata similar products (same category / brand)
    const activeProducts = await getActiveProducts(storeId);
    for (const prod of activeProducts) {
      if (prod.id === target.id) continue;

      let sim = 0;
      // Category overlap Jaccard
      const targetCats = new Set(target.categories.map((c) => c.toLowerCase()));
      const prodCats = prod.categories.map((c) => c.toLowerCase());
      const common = prodCats.filter((c) => targetCats.has(c));

      if (common.length > 0) sim += 0.5 * (common.length / Math.max(targetCats.size, 1));
      if (target.brand && prod.brand && target.brand.toLowerCase() === prod.brand.toLowerCase()) {
        sim += 0.3;
      }
      if (target.price > 0 && prod.price > 0) {
        const priceRatio = Math.min(target.price, prod.price) / Math.max(target.price, prod.price);
        if (priceRatio > 0.8) sim += 0.2;
      }

      if (sim > 0 && !candidatesMap.has(prod.id)) {
        candidatesMap.set(
          prod.id,
          createCandidate(prod, this.name, sim, {
            similarityScore: sim,
          })
        );
      }
    }

    return Array.from(candidatesMap.values());
  }
}

/**
 * 3. Trending Candidate Source (ClickHouse Recency-Weighted Activity)
 */
export class TrendingCandidateSource implements RecommendationCandidateSource {
  public readonly name = 'trending';

  public async generateCandidates(
    storeId: string,
    features: ShopperFeatures,
    options?: { limit?: number }
  ): Promise<RecommendationCandidate[]> {
    const trending = await getTrendingProductsFromCH(storeId, options?.limit || 15, 7);
    if (trending.length === 0) return [];

    const maxTrendScore = Math.max(...trending.map((t) => t.score), 1.0);
    const products = await getProductsByIds(
      storeId,
      trending.map((t) => t.productId)
    );

    const candidates: RecommendationCandidate[] = [];
    for (const prod of products) {
      const match = trending.find((t) => t.productId === prod.id);
      const normScore = match ? match.score / maxTrendScore : 0;

      candidates.push(
        createCandidate(prod, this.name, normScore, {
          trendScore: normScore,
        })
      );
    }

    return candidates;
  }
}

/**
 * 4. Popular Candidate Source (ClickHouse / Store-level Total Activity)
 */
export class PopularCandidateSource implements RecommendationCandidateSource {
  public readonly name = 'popular';

  public async generateCandidates(
    storeId: string,
    features: ShopperFeatures,
    options?: { limit?: number }
  ): Promise<RecommendationCandidate[]> {
    const popularCH = await getPopularProductsFromCH(storeId, options?.limit || 15);
    let products: ProductRecord[] = [];

    if (popularCH.length > 0) {
      products = await getProductsByIds(
        storeId,
        popularCH.map((p) => p.productId)
      );
    } else {
      // Fallback to active products in Postgres
      products = await getActiveProducts(storeId, { limit: options?.limit || 15 });
    }

    const maxCount = popularCH.length > 0 ? Math.max(...popularCH.map((p) => p.count), 1) : 1;
    const candidates: RecommendationCandidate[] = [];

    for (const prod of products) {
      const match = popularCH.find((p) => p.productId === prod.id);
      const normScore = match ? match.count / maxCount : 0.5;

      candidates.push(
        createCandidate(prod, this.name, normScore, {
          popularityScore: normScore,
        })
      );
    }

    return candidates;
  }
}

/**
 * 5. Category Candidate Source (Category Affinities & Specific Category Requests)
 */
export class CategoryCandidateSource implements RecommendationCandidateSource {
  public readonly name = 'category';

  public async generateCandidates(
    storeId: string,
    features: ShopperFeatures,
    options?: { category?: string; limit?: number }
  ): Promise<RecommendationCandidate[]> {
    const targetCategories: string[] = [];

    if (options?.category) {
      targetCategories.push(options.category);
    } else if (features.topCategoryAffinities.length > 0) {
      features.topCategoryAffinities.forEach((a) => targetCategories.push(a.member));
    }

    if (targetCategories.length === 0) return [];

    const candidates: RecommendationCandidate[] = [];
    for (const cat of targetCategories) {
      const products = await getActiveProducts(storeId, { category: cat, limit: options?.limit || 10 });
      const catAff = features.topCategoryAffinities.find((a) => a.member.toLowerCase() === cat.toLowerCase());
      const catScore = catAff ? Math.min(1.0, catAff.score / 20.0) : 0.6;

      for (const prod of products) {
        candidates.push(
          createCandidate(prod, this.name, catScore, {
            categoryScore: catScore,
          })
        );
      }
    }

    return candidates;
  }
}

/**
 * 6. Cold Start Candidate Source (For New Shoppers with Sparse History)
 */
export class ColdStartCandidateSource implements RecommendationCandidateSource {
  public readonly name = 'cold_start';

  public async generateCandidates(
    storeId: string,
    features: ShopperFeatures,
    options?: { limit?: number }
  ): Promise<RecommendationCandidate[]> {
    const activeProducts = await getActiveProducts(storeId, { limit: options?.limit || 20 });
    const candidates: RecommendationCandidate[] = [];

    const now = Date.now();
    for (const prod of activeProducts) {
      const ageInDays = Math.max(0, (now - new Date(prod.created_at).getTime()) / (1000 * 3600 * 24));
      const freshnessScore = Math.exp(-0.05 * ageInDays);

      candidates.push(
        createCandidate(prod, this.name, freshnessScore, {
          freshnessScore,
          popularityScore: 0.5,
        })
      );
    }

    return candidates;
  }
}
