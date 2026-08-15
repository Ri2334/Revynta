import { RecommendationResponse, RecommendationStrategy } from '@revynta/shared-types';
import { RecommendationCandidateSource, RecommendationConfig, ShopperFeatures } from './types.js';
import { loadRecommendationConfig } from './config.js';
import { extractShopperFeatures } from './features.js';
import {
  PersonalizedCandidateSource,
  SimilarProductCandidateSource,
  TrendingCandidateSource,
  PopularCandidateSource,
  CategoryCandidateSource,
  ColdStartCandidateSource,
} from './candidates/index.js';
import { rankCandidates } from './ranking.js';
import { RecommendationCacheManager } from './cache.js';
import { logRecommendationRun } from '@revynta/database';

export interface RecommendationModel {
  readonly version: string;
  recommend(params: {
    storeId: string;
    shopperId?: string;
    sessionId?: string;
    strategy?: RecommendationStrategy;
    productId?: string;
    category?: string;
    limit?: number;
    skipCache?: boolean;
  }): Promise<RecommendationResponse>;
}

export class HybridRecommendationModel implements RecommendationModel {
  public readonly version: string;
  private config: RecommendationConfig;
  private cacheManager: RecommendationCacheManager;
  private sources: Record<string, RecommendationCandidateSource>;

  constructor(config?: RecommendationConfig) {
    this.config = config || loadRecommendationConfig();
    this.version = this.config.modelVersion;
    this.cacheManager = new RecommendationCacheManager();

    this.sources = {
      personalized: new PersonalizedCandidateSource(),
      similar: new SimilarProductCandidateSource(),
      trending: new TrendingCandidateSource(),
      popular: new PopularCandidateSource(),
      category: new CategoryCandidateSource(),
      cold_start: new ColdStartCandidateSource(),
    };
  }

  public async recommend(params: {
    storeId: string;
    shopperId?: string;
    sessionId?: string;
    strategy?: RecommendationStrategy;
    productId?: string;
    category?: string;
    limit?: number;
    skipCache?: boolean;
  }): Promise<RecommendationResponse> {
    const { storeId, shopperId, sessionId, productId, category, skipCache } = params;
    const requestedStrategy: RecommendationStrategy = params.strategy || 'hybrid';
    const limit = Math.min(params.limit || this.config.defaultLimit, this.config.maxLimit);

    const entityType = shopperId ? 'shopper' : sessionId ? 'session' : 'store';
    const entityId = shopperId || sessionId || storeId;

    // 1. Check Redis Cache unless skipCache is requested
    if (!skipCache) {
      const cached = await this.cacheManager.get(storeId, entityType, entityId, requestedStrategy, this.version);
      if (cached) {
        return cached;
      }
    }

    // 2. Extract Shopper Features
    const features: ShopperFeatures = await extractShopperFeatures(storeId, shopperId, sessionId);

    // 3. Generate Candidates based on requested strategy
    const candidates = await this.gatherCandidates(requestedStrategy, storeId, features, {
      productId,
      category,
      limit,
    });

    // 4. Rank Candidates Deterministically
    const recommendations = rankCandidates(storeId, candidates, features, this.config, limit);

    // 5. Construct Structured Response
    const response: RecommendationResponse = {
      recommendations,
      strategy: requestedStrategy,
      generatedAt: new Date().toISOString(),
      modelVersion: this.version,
      cached: false,
    };

    // 6. Cache Response in Redis
    await this.cacheManager.set(
      storeId,
      entityType,
      entityId,
      requestedStrategy,
      response,
      this.config.cacheTtlSeconds,
      this.version
    );

    // 7. Non-blocking Log to PostgreSQL for Evaluation
    logRecommendationRun(storeId, {
      shopperId,
      sessionId,
      strategy: requestedStrategy,
      modelVersion: this.version,
      recommendedProducts: recommendations.map((r) => ({ id: r.productId, score: r.score })),
    }).catch(() => {});

    return response;
  }

  private async gatherCandidates(
    strategy: RecommendationStrategy,
    storeId: string,
    features: ShopperFeatures,
    options: { productId?: string; category?: string; limit?: number }
  ) {
    const candidatePromises: Promise<any>[] = [];

    if (strategy === 'personalized') {
      candidatePromises.push(this.sources.personalized.generateCandidates(storeId, features, options));
      candidatePromises.push(this.sources.category.generateCandidates(storeId, features, options));
    } else if (strategy === 'similar') {
      candidatePromises.push(this.sources.similar.generateCandidates(storeId, features, options));
    } else if (strategy === 'trending') {
      candidatePromises.push(this.sources.trending.generateCandidates(storeId, features, options));
    } else if (strategy === 'popular') {
      candidatePromises.push(this.sources.popular.generateCandidates(storeId, features, options));
    } else if (strategy === 'category') {
      candidatePromises.push(this.sources.category.generateCandidates(storeId, features, options));
    } else if (strategy === 'cold_start') {
      candidatePromises.push(this.sources.cold_start.generateCandidates(storeId, features, options));
    } else {
      // Hybrid Strategy (Default): Combine all candidate sources
      candidatePromises.push(this.sources.personalized.generateCandidates(storeId, features, options));
      candidatePromises.push(this.sources.similar.generateCandidates(storeId, features, options));
      candidatePromises.push(this.sources.trending.generateCandidates(storeId, features, options));
      candidatePromises.push(this.sources.popular.generateCandidates(storeId, features, options));
      candidatePromises.push(this.sources.category.generateCandidates(storeId, features, options));
      candidatePromises.push(this.sources.cold_start.generateCandidates(storeId, features, options));
    }

    const results = await Promise.all(candidatePromises);
    return results.flat();
  }
}
