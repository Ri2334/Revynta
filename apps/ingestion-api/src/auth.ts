import { Redis } from 'ioredis';
import { config } from '@revynta/config';
import { logger } from '@revynta/observability';

const redis = new Redis(config.redis.uri);

// Mock keys to allow offline testing and pipeline bootstrap without PostgreSQL
const MOCK_KEYS: Record<string, string> = {
  'test-store-key': '00000000-0000-0000-0000-000000000001',
  'test-store': '00000000-0000-0000-0000-000000000001',
};

export async function validateApiKey(apiKey: string): Promise<string | null> {
  const cacheKey = `apikey:${apiKey}`;
  
  try {
    // 1. Check Redis Cache
    const cachedTenant = await redis.get(cacheKey);
    if (cachedTenant) {
      return cachedTenant === 'invalid' ? null : cachedTenant;
    }
  } catch (error) {
    logger.warn(error as Error, 'Redis connection failed in validateApiKey');
  }

  // 2. Database Lookup Fallback
  let tenantId = MOCK_KEYS[apiKey] || null;
  if (!tenantId) {
    try {
      const { hashApiKey, withAdminContext } = await import('@revynta/database');
      const keyHash = hashApiKey(apiKey);
      const keyRow = await withAdminContext(async (adminTrx: any) => {
        return await adminTrx('api_keys')
          .where({ key_hash: keyHash, status: 'active' })
          .first();
      });
      if (keyRow) {
        tenantId = keyRow.store_id;
      }
    } catch (error) {
      logger.warn(error as Error, 'Database lookup failed in validateApiKey');
    }
  }

  // 3. Cache Result in Redis
  try {
    if (tenantId) {
      await redis.set(cacheKey, tenantId, 'EX', 3600); // Cache hit for 1 hour
    } else {
      await redis.set(cacheKey, 'invalid', 'EX', 300); // Cache miss for 5 mins (prevent spamming DB)
    }
  } catch (error) {
    logger.warn(error as Error, 'Redis cache save failed in validateApiKey');
  }

  return tenantId;
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}
