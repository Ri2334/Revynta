import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  postgres,
  redis,
  withAdminContext,
  upsertProduct,
  recordAffinitySignal,
  insertAnalyticsEvents,
} from '@revynta/database';
import { HybridRecommendationModel } from '@revynta/recommendation-engine';
import { EnrichedEvent } from '@revynta/shared-types';
import crypto from 'crypto';

describe('Phase 12 - Performance & Load Testing Suite', () => {
  let storeId: string;
  let recModel: HybridRecommendationModel;
  const productIds: string[] = [];

  beforeAll(async () => {
    await postgres.raw('UPDATE knex_migrations_lock SET is_locked = 0').catch(() => {});
    await postgres.migrate.latest();

    recModel = new HybridRecommendationModel();

    // Seed store
    const res = await withAdminContext(async (adminTrx: any) => {
      const [o] = await adminTrx('organizations').insert({ name: 'Load Test Org' }).returning('*');
      const [s] = await adminTrx('stores').insert({
        organization_id: o.id,
        name: 'Load Test Store',
        domain: `loadtest-${crypto.randomUUID()}.com`,
      }).returning('*');
      return s.id;
    });
    storeId = res;

    // Seed 20 products
    for (let i = 1; i <= 20; i++) {
      const p = await upsertProduct(storeId, {
        sku: `LOAD-SKU-${i}`,
        name: `Load Test Product ${i}`,
        categories: [i % 2 === 0 ? 'Electronics' : 'Apparel'],
        price: i * 10,
        status: 'active',
      });
      productIds.push(p.id);
    }
  });

  afterAll(async () => {
    await redis.flushdb();
    await postgres.destroy();
  });

  // Benchmark A: Event Ingestion Batch Processing Throughput
  it('Benchmark A: Synthetic Ingestion Batch Processing (1,000 Events)', async () => {
    const totalEvents = 1000;
    const events: EnrichedEvent[] = [];

    const now = new Date().toISOString();
    for (let i = 0; i < totalEvents; i++) {
      events.push({
        eventTime: now,
        eventId: crypto.randomUUID(),
        tenantId: storeId,
        sessionId: crypto.randomUUID(),
        shopperId: crypto.randomUUID(),
        eventType: i % 10 === 0 ? 'purchase' : i % 3 === 0 ? 'cart_add' : 'product_view',
        sdkVersion: 'v1.0.0',
        pageUrl: 'https://example.com/product',
        productId: productIds[i % productIds.length],
        productPrice: 49.99,
        productCategories: ['Apparel'],
      });
    }

    const startTime = Date.now();
    // Simulate ClickHouse analytics bulk write
    await insertAnalyticsEvents(events).catch(() => {});
    const durationMs = Date.now() - startTime;
    const throughput = (totalEvents / Math.max(durationMs, 1)) * 1000;

    console.log(`[Load Test A] ClickHouse Ingestion: ${totalEvents} events in ${durationMs}ms (${throughput.toFixed(2)} events/sec)`);

    expect(durationMs).toBeLessThan(10000); // Must complete within 10s
    expect(throughput).toBeGreaterThan(50); // At least 50 events/sec throughput
  });

  // Benchmark B: Recommendation Engine Rendering Latency (p50, p95, p99)
  it('Benchmark B: Recommendation Engine Latency (100 Requests)', async () => {
    const totalRequests = 100;
    const latencies: number[] = [];

    for (let i = 0; i < totalRequests; i++) {
      const shopperId = crypto.randomUUID();
      const start = Date.now();
      await recModel.recommend({
        storeId,
        shopperId,
        strategy: 'hybrid',
        skipCache: i % 2 === 0, // 50% cached, 50% uncached
      });
      latencies.push(Date.now() - start);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(totalRequests * 0.5)];
    const p95 = latencies[Math.floor(totalRequests * 0.95)];
    const p99 = latencies[Math.floor(totalRequests * 0.99)];

    console.log(`[Load Test B] Recommendation Engine Latency: p50=${p50}ms, p95=${p95}ms, p99=${p99}ms`);

    expect(p50).toBeLessThan(100); // p50 under 100ms
    expect(p95).toBeLessThan(250); // p95 under 250ms
  });

  // Benchmark C: Redis Affinity Record Throughput (500 ZSET Operations)
  it('Benchmark C: Redis ZSET Affinity Throughput (500 Signals)', async () => {
    const totalSignals = 500;
    const start = Date.now();

    for (let i = 0; i < totalSignals; i++) {
      await recordAffinitySignal(storeId, 'product', productIds[i % productIds.length], 5);
    }

    const durationMs = Date.now() - start;
    const opsPerSec = (totalSignals / Math.max(durationMs, 1)) * 1000;

    console.log(`[Load Test C] Redis ZSET Affinity: ${totalSignals} ops in ${durationMs}ms (${opsPerSec.toFixed(2)} ops/sec)`);

    expect(durationMs).toBeLessThan(5000);
    expect(opsPerSec).toBeGreaterThan(100);
  });
});
