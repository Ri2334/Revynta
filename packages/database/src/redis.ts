import { Redis } from 'ioredis';
import { config } from '@revynta/config';
import { logger } from '@revynta/observability';

export const redis = new Redis(config.redis.uri);

/**
 * Key naming pattern helpers enforcing tenant isolation
 */
export const sessionKey = (tenantId: string, sessionId: string) => `session:${tenantId}:${sessionId}`;
export const suppressionKey = (tenantId: string, shopperId: string) => `purchased_recently:${tenantId}:${shopperId}`;
export const affinityKey = (tenantId: string, dimension: string) => `affinity:${dimension}:${tenantId}`;
export const recommendationCacheKey = (
  tenantId: string,
  entityType: 'shopper' | 'session' | 'store' | 'product',
  entityId: string,
  strategy: string,
  version: string = 'hybrid-v1'
) => `recommendations:${tenantId}:${entityType}:${entityId}:${strategy}:${version}`;

/**
 * Validates connection health for Redis
 */
export async function checkRedisHealth(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === 'PONG';
  } catch (error) {
    logger.error(error as Error, 'Redis healthcheck failed');
    return false;
  }
}

/**
 * Closes the Redis client connection
 */
export async function disconnectRedis(): Promise<void> {
  await redis.quit();
  logger.info('Redis connection closed.');
}

/**
 * Updates mutable session state in Redis atomically with TTL
 */
export async function updateSessionState(
  tenantId: string,
  sessionId: string,
  updates: Record<string, string | number>,
  ttlSeconds: number = 2400
): Promise<void> {
  const key = sessionKey(tenantId, sessionId);
  const pipeline = redis.pipeline();
  pipeline.hset(key, updates);
  if (ttlSeconds > 0) {
    pipeline.expire(key, ttlSeconds);
  }
  await pipeline.exec();
}

/**
 * Retrieves the full session hash state
 */
export async function getSessionState(tenantId: string, sessionId: string): Promise<Record<string, string>> {
  const key = sessionKey(tenantId, sessionId);
  return await redis.hgetall(key);
}

/**
 * Increments affinity score in a bounded sorted set (ZSET)
 */
export async function recordAffinitySignal(
  tenantId: string,
  dimension: 'product' | 'category' | 'brand' | 'price' | 'attribute',
  memberId: string,
  increment: number = 1,
  cap: number = 200
): Promise<void> {
  const key = affinityKey(tenantId, dimension);
  const pipeline = redis.pipeline();
  pipeline.zincrby(key, increment, memberId);
  pipeline.zcard(key);
  const results = await pipeline.exec();
  
  if (results && results[1]) {
    const card = results[1][1] as number;
    if (card > cap) {
      await redis.zremrangebyrank(key, 0, card - cap - 1);
    }
  }
}

/**
 * Returns top affinity members for a given dimension
 */
export async function getTopAffinities(
  tenantId: string,
  dimension: 'product' | 'category' | 'brand' | 'price' | 'attribute',
  limit: number = 5
): Promise<Array<{ member: string; score: number }>> {
  const key = affinityKey(tenantId, dimension);
  const raw = await redis.zrevrange(key, 0, limit - 1, 'WITHSCORES');
  const results: Array<{ member: string; score: number }> = [];
  for (let i = 0; i < raw.length; i += 2) {
    results.push({ member: raw[i], score: parseFloat(raw[i + 1]) });
  }
  return results;
}

/**
 * Sets purchase suppression circuit breaker in Redis
 */
export async function setPurchaseSuppression(
  tenantId: string,
  shopperId: string,
  ttlSeconds: number = 86400
): Promise<void> {
  const key = suppressionKey(tenantId, shopperId);
  await redis.set(key, 'true', 'EX', ttlSeconds);
}

/**
 * Checks whether shopper recovery is suppressed due to recent purchase
 */
export async function isPurchaseSuppressed(tenantId: string, shopperId: string): Promise<boolean> {
  const key = suppressionKey(tenantId, shopperId);
  const val = await redis.get(key);
  return val === 'true';
}

/**
 * Stores cached recommendations in Redis
 */
export async function setCachedRecommendations(
  tenantId: string,
  entityType: 'shopper' | 'session' | 'store' | 'product',
  entityId: string,
  strategy: string,
  data: any,
  ttlSeconds: number = 300,
  version: string = 'hybrid-v1'
): Promise<void> {
  const key = recommendationCacheKey(tenantId, entityType, entityId, strategy, version);
  await redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);
}

/**
 * Retrieves cached recommendations from Redis
 */
export async function getCachedRecommendations(
  tenantId: string,
  entityType: 'shopper' | 'session' | 'store' | 'product',
  entityId: string,
  strategy: string,
  version: string = 'hybrid-v1'
): Promise<any | null> {
  const key = recommendationCacheKey(tenantId, entityType, entityId, strategy, version);
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

/**
 * Invalidates recommendation cache entries for a given store & shopper/session
 */
export async function invalidateRecommendationCache(
  tenantId: string,
  entityType: 'shopper' | 'session' | 'store' | 'product',
  entityId: string
): Promise<void> {
  const pattern = `recommendations:${tenantId}:${entityType}:${entityId}:*`;
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

