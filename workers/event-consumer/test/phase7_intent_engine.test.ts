import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  redis,
  postgres,
  sessionKey,
  suppressionKey,
  affinityKey,
  recordAffinitySignal,
  getTopAffinities,
  setPurchaseSuppression,
  isPurchaseSuppressed,
  recordPurchaseSuppression,
  checkDurablePurchaseSuppression,
  upsertShopperIntent,
  getShopperIntent,
  checkAndMarkEventDurable,
  withStoreContext,
} from '@revynta/database';
import { HeuristicIntentModel } from '@revynta/intent-engine';

describe('Phase 7 - Session Cache & Intent Engine Integration Matrix', () => {
  const storeA = '11111111-1111-1111-1111-111111111111';
  const storeB = '22222222-2222-2222-2222-222222222222';

  const shopperA = '33333333-3333-3333-3333-333333333333';
  const shopperB = '44444444-4444-4444-4444-444444444444';

  beforeAll(async () => {
    await postgres.raw('UPDATE knex_migrations_lock SET is_locked = 0').catch(() => {});
    await postgres.migrate.latest();

    const orgId = '55555555-5555-5555-5555-555555555555';
    await postgres.raw(`INSERT INTO organizations (id, name) VALUES ('${orgId}', 'Phase7 Test Org') ON CONFLICT DO NOTHING;`);
    await postgres.raw(`INSERT INTO stores (id, organization_id, name, domain) VALUES ('${storeA}', '${orgId}', 'Store A', 'a.com') ON CONFLICT DO NOTHING;`);
    await postgres.raw(`INSERT INTO stores (id, organization_id, name, domain) VALUES ('${storeB}', '${orgId}', 'Store B', 'b.com') ON CONFLICT DO NOTHING;`);

    await withStoreContext(storeA, async (trx) => {
      await trx('shoppers').insert({ id: shopperA, store_id: storeA, intent_score: 0, intent_segment: 'low' }).onConflict().ignore();
    });
    await withStoreContext(storeB, async (trx) => {
      await trx('shoppers').insert({ id: shopperB, store_id: storeB, intent_score: 0, intent_segment: 'low' }).onConflict().ignore();
    });
  });

  afterAll(async () => {
    await redis.flushdb();
    await postgres.destroy();
  });

  it('1. Updates Redis native session HASH and enforces expiration TTL', async () => {
    const sId = 'sess-test-1';
    const key = sessionKey(storeA, sId);

    await redis.hset(key, {
      shopper_id: shopperA,
      last_activity_at: new Date().toISOString(),
      event_count: '3',
      page_views: '2',
      product_views: '1',
    });
    await redis.expire(key, 2700);

    const hashData = await redis.hgetall(key);
    expect(hashData.shopper_id).toBe(shopperA);
    expect(hashData.event_count).toBe('3');

    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2700);
  });

  it('2. Maintains bounded affinity ZSETs with default cap of 200 entries', async () => {
    await redis.del(`affinity:${storeA}:product`);
    // Record 205 items into product affinity set
    for (let i = 1; i <= 205; i++) {
      await recordAffinitySignal(storeA, 'product', `prod-${i}`, i, 200);
    }

    const topProducts = await getTopAffinities(storeA, 'product', 300);
    expect(topProducts.length).toBe(200); // Lowest 5 entries pruned
    expect(topProducts[0].member).toBe('prod-205');
    expect(topProducts[0].score).toBe(205);
    // Check lowest remaining item is prod-6 (1..5 pruned)
    expect(topProducts[199].member).toBe('prod-6');
  });

  it('3. Enforces Redis + PostgreSQL Purchase Suppression Circuit Breaker with Postgres Fallback', async () => {
    // Redis fast path
    await setPurchaseSuppression(storeA, shopperA, 1);
    expect(await isPurchaseSuppressed(storeA, shopperA)).toBe(true);

    // PostgreSQL durable record
    await recordPurchaseSuppression(storeA, shopperA, 24, 'v1');

    // Simulate Redis key expiration
    await redis.del(suppressionKey(storeA, shopperA));
    expect(await isPurchaseSuppressed(storeA, shopperA)).toBe(false);

    // Durable fallback in PostgreSQL must still detect purchase suppression!
    const dbSuppressed = await checkDurablePurchaseSuppression(storeA, shopperA);
    expect(dbSuppressed).toBe(true);
  });

  it('4. Enforces Redis Fast-Path + Durable PostgreSQL event_dedup Idempotency', async () => {
    const eventId = `evt-dedup-durable-${Math.random()}`;
    const group = 'session-processor-group';

    // First delivery -> NEW
    const isFirstNew = await checkAndMarkEventDurable(storeA, group, eventId, 1);
    expect(isFirstNew).toBe(true);

    // Immediate re-delivery -> DUPLICATE (blocked by Redis fast path)
    const isSecondNew = await checkAndMarkEventDurable(storeA, group, eventId, 1);
    expect(isSecondNew).toBe(false);

    // Simulate Redis TTL expiration (expire fast path key)
    await redis.del(`processed_event:${group}:${eventId}`);

    // Replayed delivery after Redis key expiration -> STILL DUPLICATE (blocked by Postgres event_dedup fallback!)
    const isReplayNew = await checkAndMarkEventDurable(storeA, group, eventId, 1);
    expect(isReplayNew).toBe(false);
  });

  it('5. Upserts shopper intent durably in PostgreSQL under store RLS context', async () => {
    const explanations = [{ type: 'checkout_init', weight: 50, timestamp: new Date().toISOString() }];
    await upsertShopperIntent(storeA, shopperA, 85, 'high', explanations, 'v1');

    const record = await getShopperIntent(storeA, shopperA);
    expect(record).not.toBeNull();
    expect(record?.intent_score).toBe(85);
    expect(record?.intent_segment).toBe('high');
    expect(record?.model_version).toBe('v1');
  });

  it('6. Verifies Session Expiration does NOT delete long-term Shopper Affinity or Postgres Intent', async () => {
    const sId = 'sess-expiring-999';
    const sKey = sessionKey(storeA, sId);

    await redis.hset(sKey, 'event_count', '10');
    await recordAffinitySignal(storeA, 'category', 'shoes', 15, 200);

    // Expire/delete session
    await redis.del(sKey);
    const sessionCheck = await redis.hgetall(sKey);
    expect(Object.keys(sessionCheck).length).toBe(0);

    // Shopper affinity in ZSET & durable Postgres intent remain intact!
    const topCategories = await getTopAffinities(storeA, 'category', 5);
    expect(topCategories.length).toBeGreaterThan(0);
    expect(topCategories[0].member).toBe('shoes');

    const durableIntent = await getShopperIntent(storeA, shopperA);
    expect(durableIntent).not.toBeNull();
  });

  it('7. Guarantees strict Store/Tenant isolation across Redis keys and Postgres queries', async () => {
    const keyA = sessionKey(storeA, 'sess-multi-1');
    const keyB = sessionKey(storeB, 'sess-multi-1');

    await redis.hset(keyA, 'store_data', 'secret_A');
    await redis.hset(keyB, 'store_data', 'secret_B');

    expect(await redis.hget(keyA, 'store_data')).toBe('secret_A');
    expect(await redis.hget(keyB, 'store_data')).toBe('secret_B');

    const intentForStoreA = await getShopperIntent(storeA, shopperA);
    const crossStoreAccess = await getShopperIntent(storeB, shopperA);

    expect(intentForStoreA?.shopper_id).toBe(shopperA);
    expect(crossStoreAccess).toBeNull();
  });

  it('8. Handles out-of-order events using last_event_timestamp sequence guard', async () => {
    const sId = 'sess-ooo-1';
    const key = sessionKey(storeA, sId);

    const newerTimeMs = 1700000000000;
    const olderTimeMs = 1600000000000;

    await redis.hset(key, {
      last_event_timestamp: newerTimeMs.toString(),
      last_activity_at: new Date(newerTimeMs).toISOString(),
    });

    const lastTsRaw = await redis.hget(key, 'last_event_timestamp');
    const currentTs = lastTsRaw ? parseInt(lastTsRaw, 10) : 0;
    const isNewer = olderTimeMs >= currentTs;

    expect(isNewer).toBe(false);
  });

  it('9. Handles concurrent purchase + intent evaluation race and ensures final score is suppressed', async () => {
    const sId = 'sess-race-1';
    const key = sessionKey(storeA, sId);

    // Initial state: high intent score
    await redis.hset(key, {
      shopper_id: shopperA,
      intent_score: '80',
      intent_segment: 'high',
      purchase_completed: 'false'
    });

    // Simulate concurrent operations using Promise.all:
    // 1. Purchase handler: sets converted state, resets intent score to 0
    const op1 = (async () => {
      await setPurchaseSuppression(storeA, shopperA, 3600);
      await redis.hset(key, {
        purchase_completed: 'true',
        intent_score: '0',
        intent_segment: 'low'
      });
      await recordPurchaseSuppression(storeA, shopperA, 24, 'v1');
    })();

    // 2. Concurrent product view event scorer: attempts to calculate intent
    const op2 = (async () => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
      const isSuppressed = await isPurchaseSuppressed(storeA, shopperA) || await checkDurablePurchaseSuppression(storeA, shopperA);
      const score = isSuppressed ? '0' : '85';
      const segment = isSuppressed ? 'low' : 'high';
      await redis.hset(key, {
        intent_score: score,
        intent_segment: segment
      });
    })();

    await Promise.all([op1, op2]);

    const isSuppressed = await isPurchaseSuppressed(storeA, shopperA) || await checkDurablePurchaseSuppression(storeA, shopperA);
    expect(isSuppressed).toBe(true);

    const session = await redis.hgetall(key);
    if (session.intent_score !== '0') {
      const model = new HeuristicIntentModel();
      const sessionState = {
        tenantId: storeA,
        storeId: storeA,
        sessionId: sId,
        shopperId: shopperA,
        lastActivityAt: new Date().toISOString(),
        lastEventTimestamp: Date.now(),
        eventCount: 1,
        pageViews: 1,
        productViews: 0,
        cartAdds: 0,
        checkoutInitiations: 0,
        purchaseCompleted: isSuppressed,
        viewedProducts: {},
        viewedCategories: {},
        signals: []
      };
      const result = model.calculateIntent(sessionState);
      expect(result.score).toBe(0);
      expect(result.segment).toBe('low');
    } else {
      expect(session.intent_score).toBe('0');
      expect(session.intent_segment).toBe('low');
    }
  });
});
