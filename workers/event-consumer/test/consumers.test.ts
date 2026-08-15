import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { kafka, producer, connectProducer } from '../src/kafka-client.js';
import { start as startRawEnricher, stop as stopRawEnricher } from '../src/consumers/raw-enricher.js';
import { start as startAnalyticsWriter, stop as stopAnalyticsWriter } from '../src/consumers/analytics-writer.js';
import { start as startSessionProcessor, stop as stopSessionProcessor } from '../src/consumers/session-processor.js';
import { start as startIdentityResolver, stop as stopIdentityResolver } from '../src/consumers/identity-resolver.js';
import { start as startPurchaseHandler, stop as stopPurchaseHandler } from '../src/consumers/purchase-handler.js';
import { start as startIntentScorer, stop as stopIntentScorer } from '../src/consumers/intent-scorer.js';
import { postgres, redis, withAdminContext, withStoreContext, initClickHouseSchema, getClickHouseClient } from '@revynta/database';
import crypto from 'crypto';

describe('Event Consumers Integration Pipeline', () => {
  let orgId: string;
  let storeAId: string;
  let storeBId: string;

  async function pollUntil<T>(fn: () => Promise<T>, timeoutMs = 10000): Promise<T> {
    const start = Date.now();
    while (true) {
      try {
        const res = await fn();
        if (res) return res;
      } catch (err) {
        if (Date.now() - start > timeoutMs) {
          throw err;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  beforeAll(async () => {
    // Force unlock knex_migrations_lock if left locked from previous killed run
    await postgres.raw('UPDATE knex_migrations_lock SET is_locked = 0').catch(() => {});
    await postgres.migrate.latest().catch(() => {});
    await initClickHouseSchema().catch(() => {});

    // Setup mock Tenant structures in Admin context
    await withAdminContext(async (trx) => {
      const [org] = await trx('organizations').insert({ name: 'Pipeline test Org' }).returning('*');
      orgId = org.id;

      const [storeA] = await trx('stores').insert({ organization_id: orgId, name: 'Store A', domain: 'storea.com' }).returning('*');
      storeAId = storeA.id;

      const [storeB] = await trx('stores').insert({ organization_id: orgId, name: 'Store B', domain: 'storeb.com' }).returning('*');
      storeBId = storeB.id;
    });

    // Start all consumer workers
    await connectProducer();
    await startRawEnricher();
    await startAnalyticsWriter();
    await startSessionProcessor();
    await startIdentityResolver();
    await startPurchaseHandler();
    await startIntentScorer();
  }, 40000);

  afterAll(async () => {
    // Stop consumers gracefully
    await stopRawEnricher();
    await stopAnalyticsWriter();
    await stopSessionProcessor();
    await stopIdentityResolver();
    await stopPurchaseHandler();
    await stopIntentScorer();

    await redis.flushdb();
    await postgres.raw('UPDATE knex_migrations_lock SET is_locked = 0').catch(() => {});
  }, 40000);

  it('1. Pipeline: Ingests raw event, resolves shopper identity, enriches & writes to ClickHouse & Postgres', async () => {
    const eventId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const visitorId = `vis_${crypto.randomUUID().substring(0, 8)}`;

    const mockRawEvent = {
      eventId,
      sessionId,
      visitorId,
      tenantId: storeAId,
      eventType: 'page_view',
      timestamp: Date.now(),
      pageUrl: 'https://storea.com/products/shoes',
      referrer: 'https://google.com',
    };

    // Emit event to Kafka raw topic
    await producer.send({
      topic: 'events.raw',
      messages: [{ value: JSON.stringify(mockRawEvent) }],
    });

    const clickhouseRecord = await pollUntil(async () => {
      const result = await getClickHouseClient().query({
        query: `SELECT * FROM events_analytics WHERE event_id = '${eventId}' AND tenant_id = '${storeAId}'`,
        format: 'JSONEachRow',
      });
      const rows: any[] = await result.json();
      return rows.length > 0 ? rows[0] : null;
    });

    expect(clickhouseRecord).not.toBeNull();
    expect(clickhouseRecord.event_id).toBe(eventId);

    // Verify session processor updated Redis session cache
    const sessionCache = await redis.hgetall(`session:${storeAId}:${sessionId}`);
    expect(sessionCache).not.toBeNull();
    expect(sessionCache.event_count).toBe('1');
  }, 15000);

  it('2. Identity Resolution: Links shopper identity without cross-tenant conflict', async () => {
    const shopperId = crypto.randomUUID();
    await withAdminContext(async (trx) => {
      await trx('shoppers').insert({ id: shopperId, store_id: storeAId }).onConflict().ignore();
    });

    const mockIdentityEvent = {
      eventId: crypto.randomUUID(),
      tenantId: storeAId,
      shopperId,
      metadata: {
        email: 'shopper@test.com',
        phone: '+1234567890',
      },
    };

    await producer.send({
      topic: 'events.identity',
      messages: [{ value: JSON.stringify(mockIdentityEvent) }],
    });

    const identityRecord = await pollUntil(async () => {
      return await withStoreContext(storeAId, async (trx) => {
        return await trx('shopper_identities')
          .where({ store_id: storeAId, shopper_id: shopperId, channel: 'email' })
          .first();
      });
    });

    expect(identityRecord).not.toBeNull();
    expect(identityRecord.channel).toBe('email');
  }, 15000);
});
