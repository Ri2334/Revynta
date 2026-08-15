import { withStoreContext } from './postgres.js';
import { redis } from './redis.js';

export interface ShopperIntentRecord {
  id: string;
  store_id: string;
  shopper_id: string;
  intent_score: number;
  intent_segment: string;
  explanations: any;
  model_version: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Integrates Redis fast-path deduplication with durable PostgreSQL event_dedup fallback.
 * Returns true if event is NEW (should be processed), or false if it is DUPLICATE.
 */
export async function checkAndMarkEventDurable(
  storeId: string,
  consumerGroup: string,
  eventId: string,
  fastPathTtlSeconds: number = 300
): Promise<boolean> {
  const redisKey = `processed_event:${consumerGroup}:${eventId}`;
  
  // 1. Fast-Path: Check Redis
  const isRedisNew = await redis.set(redisKey, '1', 'EX', fastPathTtlSeconds, 'NX');
  if (isRedisNew !== 'OK') {
    return false; // Fast-path duplicate
  }

  // 2. Redis says it is new (or expired/evicted). We MUST check Postgres.
  const existsInPg = await withStoreContext(storeId, async (trx) => {
    const existing = await trx('event_dedup')
      .where({ store_id: storeId, consumer_group: consumerGroup, event_id: eventId })
      .first();
    return !!existing;
  });

  if (existsInPg) {
    return false; // Duplicate
  }

  // 3. Brand new event. Save to Postgres.
  try {
    await withStoreContext(storeId, async (trx) => {
      await trx('event_dedup').insert({
        store_id: storeId,
        consumer_group: consumerGroup,
        event_id: eventId,
        processed_at: new Date()
      });
    });
  } catch (err: any) {
    // Unique constraint check (23505) or foreign key check (23503) just in case of race/deleted store
    if (err.code === '23505' || err.code === '23503') {
      return false;
    }
    throw err;
  }

  return true;
}

/**
 * Upserts durable shopper intent state into PostgreSQL.
 */
export async function upsertShopperIntent(
  storeId: string,
  shopperId: string,
  intentScore: number,
  intentSegment: string,
  explanations: any[],
  modelVersion: string = 'v1'
): Promise<void> {
  await withStoreContext(storeId, async (trx) => {
    await trx.raw(
      `
      INSERT INTO shopper_intent (store_id, shopper_id, intent_score, intent_segment, explanations, model_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
      ON CONFLICT (store_id, shopper_id)
      DO UPDATE SET
        intent_score = EXCLUDED.intent_score,
        intent_segment = EXCLUDED.intent_segment,
        explanations = EXCLUDED.explanations,
        model_version = EXCLUDED.model_version,
        updated_at = NOW()
    `,
      [storeId, shopperId, intentScore, intentSegment, JSON.stringify(explanations), modelVersion]
    );

    // Also sync score to base shoppers table
    await trx('shoppers')
      .where({ id: shopperId, store_id: storeId })
      .update({
        intent_score: intentScore,
        intent_segment: intentSegment,
        updated_at: new Date(),
      });
  });
}

/**
 * Retrieves durable shopper intent record from PostgreSQL.
 */
export async function getShopperIntent(
  storeId: string,
  shopperId: string
): Promise<ShopperIntentRecord | null> {
  return await withStoreContext(storeId, async (trx) => {
    const row = await trx('shopper_intent')
      .where({ store_id: storeId, shopper_id: shopperId })
      .first();
    return row || null;
  });
}

/**
 * Records purchase suppression durably in PostgreSQL with an expiration window.
 */
export async function recordPurchaseSuppression(
  storeId: string,
  shopperId: string,
  durationHours: number = 24,
  modelVersion: string = 'v1'
): Promise<void> {
  const expiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000);
  await withStoreContext(storeId, async (trx) => {
    await trx.raw(
      `
      INSERT INTO purchase_suppression (store_id, shopper_id, suppressed_at, expires_at, model_version)
      VALUES (?, ?, NOW(), ?, ?)
      ON CONFLICT (store_id, shopper_id)
      DO UPDATE SET
        suppressed_at = NOW(),
        expires_at = EXCLUDED.expires_at,
        model_version = EXCLUDED.model_version
    `,
      [storeId, shopperId, expiresAt, modelVersion]
    );
  });
}

/**
 * Fallback check against PostgreSQL for durable purchase suppression.
 */
export async function checkDurablePurchaseSuppression(
  storeId: string,
  shopperId: string
): Promise<boolean> {
  return await withStoreContext(storeId, async (trx) => {
    const row = await trx('purchase_suppression')
      .where({ store_id: storeId, shopper_id: shopperId })
      .andWhere('expires_at', '>', new Date())
      .first();
    return !!row;
  });
}
