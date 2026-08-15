// Redis Session Cache utilities for Intent Engine
import { redis } from '@revynta/database';
import { logger } from '@revynta/observability';

/**
 * Session key pattern: `session:{tenantId}:{sessionId}`
 */
export const sessionKey = (tenantId: string, sessionId: string) => `session:${tenantId}:${sessionId}`;

/**
 * Update mutable session fields atomically via pipeline.
 */
export async function updateSession(
  tenantId: string,
  sessionId: string,
  updates: Record<string, string | number>,
  ttlSeconds: number,
) {
  const key = sessionKey(tenantId, sessionId);
  const pipeline = redis.pipeline();
  pipeline.hset(key, updates);
  if (ttlSeconds > 0) pipeline.expire(key, ttlSeconds);
  await pipeline.exec();
  logger.debug({ tenantId, sessionId }, 'Redis session updated');
}

/**
 * Retrieve session hash as a plain object.
 */
export async function getSession(tenantId: string, sessionId: string): Promise<Record<string, string>> {
  const key = sessionKey(tenantId, sessionId);
  const result = await redis.hgetall(key);
  return result;
}

/**
 * Add a score to a capped affinity sorted set.
 * key format: `affinity:{dimension}:{storeId}`
 */
export async function addAffinity(
  dimension: 'product' | 'category' | 'brand' | 'price' | 'attribute',
  storeId: string,
  memberId: string,
  increment: number,
  cap: number,
) {
  const key = `affinity:${dimension}:${storeId}`;
  const pipeline = redis.pipeline();
  pipeline.zincrby(key, increment, memberId);
  // Trim to cap (keep highest scores)
  pipeline.zremrangebyrank(key, 0, -cap - 1);
  await pipeline.exec();
  logger.debug({ storeId, dimension, memberId }, 'Affinity updated');
}

/**
 * Get top N affinities for a dimension.
 */
export async function getTopAffinity(
  dimension: 'product' | 'category' | 'brand' | 'price' | 'attribute',
  storeId: string,
  limit: number,
): Promise<Array<{ member: string; score: number }>> {
  const key = `affinity:${dimension}:${storeId}`;
  const raw = await redis.zrevrange(key, 0, limit - 1, 'WITHSCORES');
  const result: Array<{ member: string; score: number }> = [];
  for (let i = 0; i < raw.length; i += 2) {
    result.push({ member: raw[i], score: parseFloat(raw[i + 1]) });
  }
  return result;
}
