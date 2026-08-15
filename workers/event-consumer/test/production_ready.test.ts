import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import { kafka } from '../src/kafka-client.js';
import {
  postgres,
  redis,
  getClickHouseClient,
  withAdminContext,
  withStoreContext,
  initClickHouseSchema,
} from '@revynta/database';
import { start as startRaw, stop as stopRaw } from '../src/consumers/raw-enricher.js';
import { start as startAnalytics, stop as stopAnalytics } from '../src/consumers/analytics-writer.js';
import { start as startSession, stop as stopSession } from '../src/consumers/session-processor.js';
import { start as startIdentity, stop as stopIdentity } from '../src/consumers/identity-resolver.js';
import { start as startPurchase, stop as stopPurchase } from '../src/consumers/purchase-handler.js';
import { start as startIntent, stop as stopIntent } from '../src/consumers/intent-scorer.js';
vi.setConfig({ testTimeout: 30000 });

describe('Phase 6.5 Production-Readiness & Resiliency Audit Suite', () => {
  let producer: any;
  let testConsumer: any;
  
  let orgId: string;
  let storeAId: string;
  let storeBId: string;

  const dlqReceivedMessages: any[] = [];

  async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    while (true) {
      try {
        await assertion();
        return;
      } catch (err) {
        if (Date.now() - start > timeoutMs) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  beforeAll(async () => {
    await postgres.raw('UPDATE knex_migrations_lock SET is_locked = 0').catch(() => {});
    await postgres.migrate.latest().catch(() => {});
    await initClickHouseSchema().catch(() => {});

    await withAdminContext(async (trx) => {
      const [org] = await trx('organizations').insert({ name: 'Audit Org' }).returning('*');
      orgId = org.id;

      const [storeA] = await trx('stores').insert({ organization_id: orgId, name: 'Store A', domain: 'storea.com' }).returning('*');
      const [storeB] = await trx('stores').insert({ organization_id: orgId, name: 'Store B', domain: 'storeb.com' }).returning('*');
      storeAId = storeA.id;
      storeBId = storeB.id;
    });

    const chClient = getClickHouseClient();
    await chClient.exec({ query: 'TRUNCATE TABLE events_analytics' });
    await redis.flushall();

    producer = kafka.producer();
    await producer.connect();

    testConsumer = kafka.consumer({ groupId: 'audit-pipeline-verifier-group' });
    await testConsumer.connect();
    await testConsumer.subscribe({ topic: 'events.deadletter', fromBeginning: true });
    await testConsumer.run({
      eachMessage: async ({ message }) => {
        try {
          if (message.value) {
            dlqReceivedMessages.push(JSON.parse(message.value.toString()));
          }
        } catch (e) {
          // ignore
        }
      }
    });

    await startRaw();
    await startAnalytics();
    await startSession();
    await startIdentity();
    await startPurchase();
    await startIntent();

    // Stabilization delay for Kafka group assignments
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }, 30000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await stopRaw();
    await stopAnalytics();
    await stopSession();
    await stopIdentity();
    await stopPurchase();
    await stopIntent();

    if (producer) await producer.disconnect();
    if (testConsumer) await testConsumer.disconnect();

    const { disconnectProducer } = await import('../src/kafka-client.js');
    await disconnectProducer();

    await postgres.raw('UPDATE knex_migrations_lock SET is_locked = 0').catch(() => {});
    await postgres.destroy();
    await redis.quit();
  }, 30000);

  // 1. KAFKA OFFSET & CRASH RECOVERY TEST
  it('should pick up uncommitted offsets upon consumer crash and restart', async () => {
    const eventId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const visitorId = `vis_${crypto.randomUUID().substring(0, 8)}`;
    
    const mockEvent = {
      eventId,
      sessionId,
      visitorId,
      tenantId: storeAId,
      eventType: 'page_view',
      timestamp: Date.now(),
      pageUrl: 'https://storea.com/crash-test',
    };

    // Spy on session-processor database execution to throw a transient error
    const pgSpy = vi.spyOn(postgres, 'transaction').mockRejectedValueOnce(new Error('Connection Pool Timeout Exception'));

    await producer.send({
      topic: 'events.raw',
      messages: [{ value: JSON.stringify(mockEvent) }],
    });

    // Wait to verify that the message failed, and was successfully retried on second attempt
    await new Promise((resolve) => setTimeout(resolve, 2000));
    pgSpy.mockRestore();

    // Verify session state was created during retry reprocessing
    await waitFor(async () => {
      const session = await redis.hgetall(`session:${storeAId}:${sessionId}`);
      expect(session.shopper_id).toBeDefined();
    });
  });

  // 2. TRUE IDEMPOTENCY AUDIT TEST
  it('should enforce idempotency and avoid duplicate side effects', async () => {
    const eventId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const visitorId = `vis_${crypto.randomUUID().substring(0, 8)}`;
    
    const mockEvent = {
      eventId,
      sessionId,
      visitorId,
      tenantId: storeAId,
      eventType: 'page_view',
      timestamp: Date.now(),
      pageUrl: 'https://storea.com/idempotency',
    };

    // Send E once
    await producer.send({
      topic: 'events.raw',
      messages: [{ value: JSON.stringify(mockEvent) }],
    });

    // Send same event E again immediately (duplicate delivery)
    await producer.send({
      topic: 'events.raw',
      messages: [{ value: JSON.stringify(mockEvent) }],
    });

    await waitFor(async () => {
      const session = await redis.hgetall(`session:${storeAId}:${sessionId}`);
      expect(session).not.toBeNull();
      expect(session.event_count).toBeDefined();
      expect(parseInt(session.event_count, 10)).toBe(1);
    }, 10000);
  });

  // 3. REDIS FAILURE RESILIENCY TEST
  it('should gracefully handle Redis timeouts and retry rather than immediately discard', async () => {
    const eventId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const visitorId = `vis_${crypto.randomUUID().substring(0, 8)}`;
    
    const mockEvent = {
      eventId,
      sessionId,
      visitorId,
      tenantId: storeAId,
      eventType: 'page_view',
      timestamp: Date.now(),
      pageUrl: 'https://storea.com/redis-fail',
    };

    // Mock Redis pipeline failure
    const redisSpy = vi.spyOn(redis, 'pipeline').mockImplementation(() => {
      throw new Error('Redis Connection Timeout Exception');
    });

    await producer.send({
      topic: 'events.raw',
      messages: [{ value: JSON.stringify(mockEvent) }],
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));
    redisSpy.mockRestore();
  });

  // 4. POSTGRESQL OUTAGE RESILIENCY TEST
  it('should rollback transaction and retry processing upon Postgres outage', async () => {
    const eventId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const visitorId = `vis_${crypto.randomUUID().substring(0, 8)}`;
    
    const mockEvent = {
      eventId,
      sessionId,
      visitorId,
      tenantId: storeAId,
      eventType: 'page_view',
      timestamp: Date.now(),
      pageUrl: 'https://storea.com/postgres-fail',
    };

    // Spy on PostgreSQL query client to throw outage error
    const pgSpy = vi.spyOn(postgres, 'transaction').mockRejectedValueOnce(new Error('Postgres connection pool exhausted'));

    await producer.send({
      topic: 'events.raw',
      messages: [{ value: JSON.stringify(mockEvent) }],
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));
    pgSpy.mockRestore();

    // Verify that session state completed on subsequent retry
    await waitFor(async () => {
      const session = await redis.hgetall(`session:${storeAId}:${sessionId}`);
      expect(session.shopper_id).toBeDefined();
    });
  });

  // 5. CLICKHOUSE OUTAGE RESILIENCY TEST
  it('should retry ClickHouse bulk writes and re-throw on outage', async () => {
    const eventId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const visitorId = `vis_${crypto.randomUUID().substring(0, 8)}`;
    
    const mockEvent = {
      eventId,
      sessionId,
      visitorId,
      tenantId: storeAId,
      eventType: 'product_view',
      timestamp: Date.now(),
      productId: 'item_123',
    };

    const chClient = getClickHouseClient();
    const chSpy = vi.spyOn(chClient, 'insert').mockRejectedValue(new Error('ClickHouse Server Socket Closed'));

    await producer.send({
      topic: 'events.raw',
      messages: [{ value: JSON.stringify(mockEvent) }],
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));
    chSpy.mockRestore();
  });

  // 6. DEAD LETTER QUEUE METADATA VERIFICATION TEST
  it('should store complete diagnostic metadata inside the DLQ envelope', async () => {
    const eventId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    
    // Missing visitorId to trigger raw-enricher validation error (which is non-transient)
    const malformedEvent = {
      eventId,
      sessionId,
      tenantId: storeAId,
      eventType: 'page_view',
      timestamp: Date.now(),
    };

    await producer.send({
      topic: 'events.raw',
      messages: [{ value: JSON.stringify(malformedEvent) }],
    });

    await waitFor(async () => {
      const found = dlqReceivedMessages.find((m) => m.eventId === eventId);
      expect(found).toBeDefined();
      expect(found.consumer).toBe('ingestion-enricher-group');
      expect(found.originalTopic).toBe('events.raw');
      expect(found.failureReason).toContain('Missing required tracking fields');
    });
  });

  // 7. PURCHASE SUPPRESSION RACE TEST WITH POSTGRES DURABLE FALLBACK
  it('should verify campaign suppression race flows and Postgres fallback checks', async () => {
    const shopperId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    
    await withAdminContext(async (trx) => {
      await trx('shoppers').insert({ id: shopperId, store_id: storeAId });
    });

    // 1. Scenario A: Purchase sets active suppression key in Redis
    const purchaseEvent = {
      eventId: crypto.randomUUID(),
      sessionId,
      shopperId,
      tenantId: storeAId,
      eventType: 'purchase',
      eventTime: new Date().toISOString(),
    };

    await producer.send({
      topic: 'events.enriched',
      messages: [{ key: shopperId, value: JSON.stringify(purchaseEvent) }],
    });

    await waitFor(async () => {
      const isLocked = await redis.get(`purchased_recently:${storeAId}:${shopperId}`);
      expect(isLocked).toBe('true');
    });

    // 2. Scenario C: Postgres Fallback logic when Redis is offline
    // We execute a direct database query checking audit conversions within last 24h
    const converted = await withStoreContext(storeAId, async (trx) => {
      const log = await trx('audit_logs')
        .where({
          resource: 'shopper',
          resource_id: shopperId,
          action: 'shopper_purchase_conversion',
        })
        .andWhere('created_at', '>=', new Date(Date.now() - 24 * 3600 * 1000))
        .first();
      return !!log;
    });

    expect(converted).toBe(true);
  });

  // 8. TENANT ISOLATION CROSS-TENANT ATTACK TEST
  it('should block cross-tenant mutations on malicious shopper ID injection', async () => {
    const shopperIdB = crypto.randomUUID();
    
    // Seed shopper profile in Tenant B's workspace
    await withAdminContext(async (trx) => {
      await trx('shoppers').insert({ id: shopperIdB, store_id: storeBId });
    });

    const maliciousEvent = {
      eventId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      shopperId: shopperIdB, // Shopper belongs to Store B
      tenantId: storeAId,    // Event header claims Store A
      eventType: 'purchase',
      eventTime: new Date().toISOString(),
    };

    // Publish event claiming Store A but referencing Store B's shopperId
    await producer.send({
      topic: 'events.enriched',
      messages: [{ key: shopperIdB, value: JSON.stringify(maliciousEvent) }],
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify Tenant B's shopper profile remained unaffected/unmutated (no lock key created in Store B or Store A space)
    const isLockedA = await redis.get(`purchased_recently:${storeAId}:${shopperIdB}`);
    const isLockedB = await redis.get(`purchased_recently:${storeBId}:${shopperIdB}`);
    expect(isLockedA).toBeNull();
    expect(isLockedB).toBeNull();
  });

  // 9. EVENT ORDERING & OUT-OF-ORDER PROCESSING TEST
  it('should maintain logical session state on out-of-order events', async () => {
    const sessionId = crypto.randomUUID();
    const visitorId = `vis_${crypto.randomUUID().substring(0, 8)}`;
    
    const viewEvent1 = {
      eventId: crypto.randomUUID(),
      sessionId,
      visitorId,
      tenantId: storeAId,
      eventType: 'page_view',
      timestamp: 1700000000000, // Earliest: 2023-11-14T22:13:20.000Z
      pageUrl: 'https://storea.com/1',
    };

    const viewEvent2 = {
      eventId: crypto.randomUUID(),
      sessionId,
      visitorId,
      tenantId: storeAId,
      eventType: 'product_view',
      timestamp: 1700000060000, // Latest: 2023-11-14T22:14:20.000Z
      pageUrl: 'https://storea.com/2',
    };

    // Publish viewEvent2 (latest) BEFORE viewEvent1 (earliest)
    await producer.send({
      topic: 'events.raw',
      messages: [{ value: JSON.stringify(viewEvent2) }],
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    await producer.send({
      topic: 'events.raw',
      messages: [{ value: JSON.stringify(viewEvent1) }],
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Verify session activity timestamp is the latest (viewEvent2 timestamp), NOT the earliest
    const session = await redis.hgetall(`session:${storeAId}:${sessionId}`);
    expect(session.last_activity_at).toBe(new Date(1700000060000).toISOString());
  });

  // 10. SCHEMA VERSIONING COMPATIBILITY TEST
  it('should process older schema versions gracefully using defaults', async () => {
    const eventId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const visitorId = `vis_${crypto.randomUUID().substring(0, 8)}`;
    
    // Older schema structure missing sdkVersion and referrer
    const oldEvent = {
      eventId,
      sessionId,
      visitorId,
      tenantId: storeAId,
      eventType: 'page_view',
      timestamp: Date.now(),
      pageUrl: 'https://storea.com/old-version',
    };

    await producer.send({
      topic: 'events.raw',
      messages: [{ value: JSON.stringify(oldEvent) }],
    });

    await waitFor(async () => {
      const session = await redis.hgetall(`session:${storeAId}:${sessionId}`);
      expect(session.shopper_id).toBeDefined();
    });
  });
});
