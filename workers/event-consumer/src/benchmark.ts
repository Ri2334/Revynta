import { kafka } from './kafka-client.js';
import {
  postgres,
  redis,
  getClickHouseClient,
  withAdminContext,
  getShopperIntent,
} from '@revynta/database';
import { HeuristicIntentModel, SessionState } from '@revynta/intent-engine';
import { start as startRaw, stop as stopRaw } from './consumers/raw-enricher.js';
import { start as startAnalytics, stop as stopAnalytics } from './consumers/analytics-writer.js';
import { start as startSession, stop as stopSession } from './consumers/session-processor.js';
import { start as startIntent, stop as stopIntent } from './consumers/intent-scorer.js';
import crypto from 'crypto';

const tenantId = '08610c5a-ce9b-44ab-a8d3-a0d2287f445f';

function calculatePercentiles(latencies: number[]) {
  if (latencies.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || sorted[0];
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || sorted[sorted.length - 1];
  return { p50, p95, p99 };
}

async function runBenchmark() {
  console.log('=== STARTING LOCAL TELEMETRY & INTENT PIPELINE BENCHMARK ===');

  await postgres.raw('UPDATE knex_migrations_lock SET is_locked = 0').catch(() => {});
  await postgres.migrate.latest();
  const chClient = getClickHouseClient();
  await chClient.exec({ query: 'TRUNCATE TABLE events_analytics' });
  await redis.flushall();

  await withAdminContext(async (trx) => {
    await trx('shoppers').where({ store_id: tenantId }).delete();
    await trx('stores').where({ id: tenantId }).delete();
    await trx('organizations').delete();

    const [org] = await trx('organizations').insert({ name: 'Benchmark Org' }).returning('*');
    await trx('stores').insert({
      id: tenantId,
      organization_id: org.id,
      name: 'Benchmark Store',
      domain: 'benchmark.com',
    });
  });

  // Measure direct Redis & Postgres latencies
  const redisLatencies: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    await redis.ping();
    redisLatencies.push(performance.now() - t0);
  }

  const pgLatencies: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await postgres.raw('SELECT 1');
    pgLatencies.push(performance.now() - t0);
  }

  // Measure pure Intent Calculation latencies across 1,000 evaluations
  const intentModel = new HeuristicIntentModel();
  const intentLatencies: number[] = [];
  const mockSession: SessionState = {
    tenantId,
    storeId: tenantId,
    sessionId: 'bench-session',
    shopperId: 'bench-shopper',
    lastActivityAt: new Date().toISOString(),
    lastEventTimestamp: Date.now(),
    eventCount: 10,
    pageViews: 5,
    productViews: 3,
    cartAdds: 1,
    checkoutInitiations: 1,
    purchaseCompleted: false,
    viewedProducts: {},
    viewedCategories: {},
    signals: [
      { type: 'product_view', weight: 5, timestamp: new Date().toISOString() },
      { type: 'cart_add', weight: 25, timestamp: new Date().toISOString() },
      { type: 'checkout_init', weight: 50, timestamp: new Date().toISOString() },
    ],
  };

  for (let i = 0; i < 1000; i++) {
    const t0 = performance.now();
    intentModel.calculateIntent(mockSession);
    intentLatencies.push(performance.now() - t0);
  }

  const producer = kafka.producer();
  await producer.connect();

  console.log('Booting raw-enricher, analytics-writer, session-processor, and intent-scorer consumers...');
  await startRaw();
  await startAnalytics();
  await startSession();
  await startIntent();

  console.log('Waiting 4s for consumer groups to stabilize...');
  await new Promise((resolve) => setTimeout(resolve, 4000));

  const NUM_EVENTS = process.env.NUM_EVENTS ? parseInt(process.env.NUM_EVENTS, 10) : 1000;
  const events: any[] = [];
  const sessionId = crypto.randomUUID();
  const visitorId = 'vis_benchmark_123';

  for (let i = 0; i < NUM_EVENTS; i++) {
    const eventType = i % 10 === 0 ? 'checkout_init' : i % 5 === 0 ? 'cart_add' : i % 2 === 0 ? 'product_view' : 'page_view';
    events.push({
      eventId: crypto.randomUUID(),
      sessionId,
      visitorId,
      tenantId,
      eventType,
      timestamp: Date.now(),
      pageUrl: 'https://storea.com/benchmark',
      sdkVersion: '1.0.0',
      productId: 'prod_bench_1',
    });
  }

  console.log(`Publishing ${NUM_EVENTS} telemetry events to 'events.raw' in batches of 100...`);
  const publishStart = Date.now();
  const batchSize = 100;
  let errorCount = 0;

  for (let i = 0; i < NUM_EVENTS; i += batchSize) {
    const chunk = events.slice(i, i + batchSize).map((e) => ({
      value: JSON.stringify(e),
    }));
    try {
      await producer.send({
        topic: 'events.raw',
        messages: chunk,
      });
    } catch (err) {
      errorCount++;
    }
  }

  const publishDuration = Date.now() - publishStart;
  console.log(`Kafka ingestion published successfully in ${publishDuration}ms.`);

  console.log('Polling ClickHouse and Redis for pipeline ingestion & intent scoring completion...');
  const pipelineStart = Date.now();
  let chCount = 0;
  let chCompleted = false;

  while (Date.now() - pipelineStart < 30000) {
    const chResult = await chClient.query({
      query: 'SELECT count() as count FROM events_analytics',
      format: 'JSONEachRow',
    });
    const rows = await chResult.json<any>();
    chCount = parseInt(rows[0].count, 10);

    if (chCount >= NUM_EVENTS) {
      chCompleted = true;
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const totalPipelineTime = Date.now() - pipelineStart;
  const intentStats = calculatePercentiles(intentLatencies);
  const redisStats = calculatePercentiles(redisLatencies);
  const pgStats = calculatePercentiles(pgLatencies);

  if (!chCompleted) {
    console.error(`Benchmark Timeout: ClickHouse ingested ${chCount}/${NUM_EVENTS} events.`);
  } else {
    const redisSession = await redis.hgetall(`session:${tenantId}:${sessionId}`);
    const resolvedShopperId = redisSession.shopper_id;
    const intentRecord = resolvedShopperId ? await getShopperIntent(tenantId, resolvedShopperId) : null;

    console.log('=== INTENT ENGINE BENCHMARK EXECUTION RESULTS ===');
    console.log(`- Total Events Processed: ${NUM_EVENTS}`);
    console.log(`- Ingestion Publish Latency: ${publishDuration}ms (${Math.round(NUM_EVENTS / (publishDuration / 1000))} events/sec)`);
    console.log(`- Total Pipeline Processing Time: ${totalPipelineTime}ms`);
    console.log(`- Pipeline Processing Throughput: ${Math.round(NUM_EVENTS / (totalPipelineTime / 1000))} events/sec`);
    console.log(`- Intent Calculation Latency p50: ${intentStats.p50.toFixed(3)}ms`);
    console.log(`- Intent Calculation Latency p95: ${intentStats.p95.toFixed(3)}ms`);
    console.log(`- Intent Calculation Latency p99: ${intentStats.p99.toFixed(3)}ms`);
    console.log(`- Redis Latency p50: ${redisStats.p50.toFixed(3)}ms | p95: ${redisStats.p95.toFixed(3)}ms`);
    console.log(`- PostgreSQL Latency p50: ${pgStats.p50.toFixed(3)}ms | p95: ${pgStats.p95.toFixed(3)}ms`);
    console.log(`- Pipeline Error Count: ${errorCount}`);
    console.log(`- Redis Final Session Event Count: ${redisSession.event_count}`);
    console.log(`- Redis Final Session Intent Score: ${redisSession.intent_score}`);
    console.log(`- Redis Final Session Intent Segment: ${redisSession.intent_segment}`);
    console.log(`- PostgreSQL Durable Intent Score: ${intentRecord?.intent_score}`);
    console.log(`- PostgreSQL Durable Intent Segment: ${intentRecord?.intent_segment}`);
    console.log(`- Model Version: ${intentRecord?.model_version}`);
  }

  console.log('Stopping background consumers...');
  await stopRaw();
  await stopAnalytics();
  await stopSession();
  await stopIntent();
  await producer.disconnect();
  await chClient.close();
  await postgres.destroy();
  await redis.quit();

  console.log('=== BENCHMARK COMPLETED ===');
  process.exit(0);
}

runBenchmark().catch((err) => {
  console.error('Benchmark crashed:', err);
  process.exit(1);
});
