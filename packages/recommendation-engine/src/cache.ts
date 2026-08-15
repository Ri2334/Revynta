import {
  getCachedRecommendations,
  setCachedRecommendations,
  invalidateRecommendationCache,
} from '@revynta/database';
import { RecommendationResponse, RecommendationStrategy } from '@revynta/shared-types';

export class RecommendationCacheManager {
  /**
   * Retrieves cached recommendation response enforcing tenant and strategy key isolation
   */
  public async get(
    storeId: string,
    entityType: 'shopper' | 'session' | 'store' | 'product',
    entityId: string,
    strategy: RecommendationStrategy,
    modelVersion: string = 'hybrid-v1'
  ): Promise<RecommendationResponse | null> {
    const data = await getCachedRecommendations(storeId, entityType, entityId, strategy, modelVersion);
    if (data) {
      return {
        ...data,
        cached: true,
      };
    }
    return null;
  }

  /**
   * Caches recommendation response in Redis with TTL
   */
  public async set(
    storeId: string,
    entityType: 'shopper' | 'session' | 'store' | 'product',
    entityId: string,
    strategy: RecommendationStrategy,
    response: RecommendationResponse,
    ttlSeconds: number = 300,
    modelVersion: string = 'hybrid-v1'
  ): Promise<void> {
    await setCachedRecommendations(storeId, entityType, entityId, strategy, response, ttlSeconds, modelVersion);
  }

  /**
   * Clears tenant recommendation cache entries for an entity
   */
  public async invalidate(
    storeId: string,
    entityType: 'shopper' | 'session' | 'store' | 'product',
    entityId: string
  ): Promise<void> {
    await invalidateRecommendationCache(storeId, entityType, entityId);
  }
}
