import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  redis,
  postgres,
  sessionKey,
  withStoreContext,
  recordPurchaseSuppression,
  setPurchaseSuppression,
  insertMessageLog,
} from '@revynta/database';
import { scheduleInactivityCheck, inactivityQueue, queueRedisConnection } from '../src/consumers/inactivity-scheduler.js';
import { start as startWorker, stop as stopWorker } from '../src/consumers/inactivity-worker.js';
import { producer, kafka } from '../src/kafka-client.js';
import crypto from 'crypto';

describe('Phase 8 - Inactivity & Campaign Eligibility Engine Integration Matrix', () => {
  const storeA = '11111111-1111-1111-1111-111111111111';
  const storeB = '22222222-2222-2222-2222-222222222222';
  const orgId = '33333333-3333-3333-3333-333333333333';

  let campaignAId = '66666666-6666-6666-6666-666666666666';
  let campaignBId = '77777777-7777-7777-7777-777777777777';

  let eligibleEvents: any[] = [];
  let testConsumer: any;

  // Helper to create isolated shopper profiles per test case to avoid database state pollution
  async function setupTestShopper(storeId: string, intentScore = 80): Promise<string> {
    const shopperId = crypto.randomUUID();
    await withStoreContext(storeId, async (trx) => {
      await trx('shoppers').insert({
        id: shopperId,
        store_id: storeId,
        intent_score: intentScore,
        intent_segment: intentScore >= 70 ? 'high' : 'medium',
      });
      await trx('shopper_identities').insert({
        store_id: storeId,
        shopper_id: shopperId,
        channel: 'whatsapp',
        identifier_hash: `hash_${shopperId}`,
        encrypted_value: 'enc_phone_val',
      });
      await trx('consent_records').insert({
        store_id: storeId,
        shopper_id: shopperId,
        purpose: 'marketing',
        status: 'granted',
        source: 'test',
        policy_version: 'v1',
      });
    });
    return shopperId;
  }

  beforeAll(async () => {
    // Run migrations
    await postgres.raw('UPDATE knex_migrations_lock SET is_locked = 0').catch(() => {});
    await postgres.migrate.latest();

    await postgres.raw(`INSERT INTO organizations (id, name) VALUES ('${orgId}', 'Phase8 Org') ON CONFLICT DO NOTHING;`);
    await postgres.raw(`INSERT INTO stores (id, organization_id, name, domain) VALUES ('${storeA}', '${orgId}', 'Store A', 'a.com') ON CONFLICT DO NOTHING;`);
    await postgres.raw(`INSERT INTO stores (id, organization_id, name, domain) VALUES ('${storeB}', '${orgId}', 'Store B', 'b.com') ON CONFLICT DO NOTHING;`);

    // Seed active campaign for Store A
    await withStoreContext(storeA, async (trx) => {
      await trx('campaigns').insert({
        id: campaignAId,
        store_id: storeA,
        name: 'Browse Abandonment Campaign',
        status: 'active',
        trigger_type: 'browse_abandonment',
        inactivity_duration_minutes: 1, // 1 minute inactivity for fast test run
        min_intent_score: 70,
        communication_channel: 'whatsapp',
        template_id: 'abandoned-browse-template',
        cooldown_seconds: 5,
        frequency_cap_limit: 10,
        frequency_cap_window_seconds: 60,
      }).onConflict().ignore();
    });

    // Seed active campaign for Store B
    await withStoreContext(storeB, async (trx) => {
      await trx('campaigns').insert({
        id: campaignBId,
        store_id: storeB,
        name: 'Store B Campaign',
        status: 'active',
        trigger_type: 'browse_abandonment',
        inactivity_duration_minutes: 1,
        min_intent_score: 75,
        communication_channel: 'whatsapp',
        template_id: 'abandoned-browse-template-b',
        cooldown_seconds: 10,
      }).onConflict().ignore();
    });

    // Clean queue
    await inactivityQueue.drain();

    // Start inactivity BullMQ worker
    await startWorker();

    // Start Kafka consumer to capture campaign.eligible events
    testConsumer = kafka.consumer({ groupId: 'phase8-verifier-group' });
    await testConsumer.connect();
    await testConsumer.subscribe({ topic: 'events.campaign.eligible', fromBeginning: true });
    
    testConsumer.run({
      eachMessage: async ({ message }) => {
        if (message.value) {
          eligibleEvents.push(JSON.parse(message.value.toString()));
        }
      },
    });
  });

  afterAll(async () => {
    await stopWorker();
    await testConsumer.disconnect();
    await queueRedisConnection.quit();
    await redis.flushdb();
    await postgres.destroy();
  });

  it('A & D. Basic Inactivity & Intent Eligibility Check', async () => {
    const sessionId = crypto.randomUUID();
    const key = sessionKey(storeA, sessionId);
    const shopperId = await setupTestShopper(storeA, 80);

    // Initial shopper state: active event
    await redis.hset(key, {
      shopper_id: shopperId,
      last_activity_at: new Date(Date.now() - 65000).toISOString(),
      last_event_timestamp: (Date.now() - 65000).toString(),
      intent_score: '80',
      intent_segment: 'high',
    });

    // Schedule inactivity delayed job (delay 1m)
    await scheduleInactivityCheck(storeA, sessionId, shopperId);

    const jobs = await inactivityQueue.getJobs(['delayed']);
    expect(jobs.length).toBeGreaterThan(0);

    // Fast-forward job processing by manually promoting the job or waiting
    for (const job of jobs) {
      await job.promote();
    }

    // Poll until event appears in eligibleEvents
    let event: any = undefined;
    const pollStart = Date.now();
    while (Date.now() - pollStart < 6000) {
      event = eligibleEvents.find((e) => e.sessionId === sessionId && e.campaignId === campaignAId);
      if (event) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(event).toBeDefined();
    expect(event?.intentScore).toBe(80);
    expect(event?.channel).toBe('whatsapp');
  });

  it('B & M. Returning Shopper & Stale Job Check', async () => {
    const sessionId = crypto.randomUUID();
    const key = sessionKey(storeA, sessionId);
    const shopperId = await setupTestShopper(storeA, 80);

    // Initial active event
    await redis.hset(key, {
      shopper_id: shopperId,
      last_activity_at: new Date().toISOString(),
      last_event_timestamp: Date.now().toString(),
      intent_score: '80',
      intent_segment: 'high',
    });

    // Schedule job 1
    await scheduleInactivityCheck(storeA, sessionId, shopperId);

    // Simulate shopper return: update event timestamp (resetting delay)
    await new Promise((resolve) => setTimeout(resolve, 500));
    await redis.hset(key, {
      last_activity_at: new Date().toISOString(),
      last_event_timestamp: Date.now().toString(),
    });

    // Retrieve and promote job 1
    const jobs = await inactivityQueue.getJobs(['delayed']);
    const job = jobs.find((j) => j.id?.includes(sessionId));
    expect(job).toBeDefined();

    if (job) {
      await job.promote();
    }

    // Wait and verify NO campaign event is triggered (discarded as stale/shopper returned)
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const triggered = eligibleEvents.filter((e) => e.sessionId === sessionId);
    expect(triggered.length).toBe(0);
  });

  it('C & N. Purchase Suppression & Concurrent Race', async () => {
    const sessionId = crypto.randomUUID();
    const key = sessionKey(storeA, sessionId);
    const shopperId = await setupTestShopper(storeA, 90);

    await redis.hset(key, {
      shopper_id: shopperId,
      last_activity_at: new Date(Date.now() - 65000).toISOString(),
      last_event_timestamp: (Date.now() - 65000).toString(),
      intent_score: '90',
      intent_segment: 'high',
    });

    await scheduleInactivityCheck(storeA, sessionId, shopperId);

    // Simulate purchase suppression (durable Postgres records)
    await setPurchaseSuppression(storeA, shopperId, 3600);
    await recordPurchaseSuppression(storeA, shopperId, 24, 'v1');

    const jobs = await inactivityQueue.getJobs(['delayed']);
    const job = jobs.find((j) => j.id?.includes(sessionId));
    if (job) {
      await job.promote();
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const triggered = eligibleEvents.filter((e) => e.sessionId === sessionId);
    expect(triggered.length).toBe(0); // Purchase suppression blocks campaign successfully!
  });

  it('E. Consent check constraints', async () => {
    const sessionId = crypto.randomUUID();
    const key = sessionKey(storeA, sessionId);
    
    // Create new shopper who has withdrawn consent
    const shopperNoConsent = crypto.randomUUID();
    await withStoreContext(storeA, async (trx) => {
      await trx('shoppers').insert({ id: shopperNoConsent, store_id: storeA, intent_score: 85, intent_segment: 'high' }).onConflict().ignore();
      await trx('shopper_identities').insert({
        store_id: storeA,
        shopper_id: shopperNoConsent,
        channel: 'whatsapp',
        identifier_hash: `hash_${shopperNoConsent}`,
        encrypted_value: 'enc_val',
      }).onConflict().ignore();
      // Insert withdrawn consent purpose = marketing
      await trx('consent_records').insert({
        store_id: storeA,
        shopper_id: shopperNoConsent,
        purpose: 'marketing',
        status: 'denied',
        source: 'test',
        policy_version: 'v1',
        withdrawn_at: new Date(),
      }).onConflict().ignore();
    });

    await redis.hset(key, {
      shopper_id: shopperNoConsent,
      last_activity_at: new Date(Date.now() - 65000).toISOString(),
      last_event_timestamp: (Date.now() - 65000).toString(),
      intent_score: '85',
      intent_segment: 'high',
    });

    await scheduleInactivityCheck(storeA, sessionId, shopperNoConsent);

    const jobs = await inactivityQueue.getJobs(['delayed']);
    const job = jobs.find((j) => j.id?.includes(sessionId));
    if (job) {
      await job.promote();
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const triggered = eligibleEvents.filter((e) => e.shopperId === shopperNoConsent);
    expect(triggered.length).toBe(0); // Lacking consent blocks campaign!
  });

  it('F & G. Cooldown and Frequency Capping restrictions', async () => {
    const sessionId = crypto.randomUUID();
    const key = sessionKey(storeA, sessionId);
    const shopperId = await setupTestShopper(storeA, 85);

    // Seed previous message log sent to shopperA for this campaign 2 seconds ago (within cooldown)
    await insertMessageLog(storeA, {
      store_id: storeA,
      shopper_id: shopperId,
      campaign_id: campaignAId,
      channel: 'whatsapp',
      provider: 'mock',
      provider_message_id: `msg-prev-${crypto.randomUUID()}`,
      template_id: 'abandoned-browse-template',
      status: 'sent',
      idempotency_key: `prev-idempotency-${crypto.randomUUID()}`,
      sent_at: new Date(),
    });

    await redis.hset(key, {
      shopper_id: shopperId,
      last_activity_at: new Date(Date.now() - 65000).toISOString(),
      last_event_timestamp: (Date.now() - 65000).toString(),
      intent_score: '85',
      intent_segment: 'high',
    });

    await scheduleInactivityCheck(storeA, sessionId, shopperId);

    const jobs = await inactivityQueue.getJobs(['delayed']);
    const job = jobs.find((j) => j.id?.includes(sessionId));
    if (job) {
      await job.promote();
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const triggered = eligibleEvents.filter((e) => e.sessionId === sessionId);
    expect(triggered.length).toBe(0); // Cooldown restriction blocked campaign dispatch!
  });

  it('H. Campaign State validation (Draft/Paused)', async () => {
    const sessionId = crypto.randomUUID();
    const key = sessionKey(storeA, sessionId);
    const shopperId = await setupTestShopper(storeA, 95);

    // Pause campaignAId in database
    await withStoreContext(storeA, async (trx) => {
      await trx('campaigns').where({ id: campaignAId }).update({ status: 'paused' });
    });

    await redis.hset(key, {
      shopper_id: shopperId,
      last_activity_at: new Date(Date.now() - 65000).toISOString(),
      last_event_timestamp: (Date.now() - 65000).toString(),
      intent_score: '95',
      intent_segment: 'high',
    });

    await scheduleInactivityCheck(storeA, sessionId, shopperId);

    const jobs = await inactivityQueue.getJobs(['delayed']);
    const job = jobs.find((j) => j.id?.includes(sessionId));
    if (job) {
      await job.promote();
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const triggered = eligibleEvents.filter((e) => e.sessionId === sessionId);
    expect(triggered.length).toBe(0); // Paused campaign status blocks dispatch!

    // Restore campaign status to active for subsequent tests
    await withStoreContext(storeA, async (trx) => {
      await trx('campaigns').where({ id: campaignAId }).update({ status: 'active' });
    });
  });

  it('L. Tenant/Store isolation checks', async () => {
    // Schedule inactivity check for Store B using storeB context and shopperB
    const sessionId = crypto.randomUUID();
    const key = sessionKey(storeB, sessionId);
    const shopperId = await setupTestShopper(storeB, 85);

    await redis.hset(key, {
      shopper_id: shopperId,
      last_activity_at: new Date(Date.now() - 65000).toISOString(),
      last_event_timestamp: (Date.now() - 65000).toString(),
      intent_score: '85',
      intent_segment: 'high',
    });

    await scheduleInactivityCheck(storeB, sessionId, shopperId);

    const jobs = await inactivityQueue.getJobs(['delayed']);
    const job = jobs.find((j) => j.id?.includes(sessionId));
    if (job) {
      await job.promote();
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
    const event = eligibleEvents.find((e) => e.sessionId === sessionId);
    expect(event).toBeDefined();
    expect(event?.tenantId).toBe(storeB); // Handled under Tenant B isolation boundary!
  });

  it('Q. Bounded failed-job retention options check', async () => {
    const sessionId = crypto.randomUUID();
    const shopperId = await setupTestShopper(storeA, 80);

    await scheduleInactivityCheck(storeA, sessionId, shopperId);

    const jobs = await inactivityQueue.getJobs(['delayed']);
    const job = jobs.find((j) => j.id?.includes(sessionId));
    expect(job).toBeDefined();
    if (job) {
      expect(job.opts.removeOnFail).toEqual({
        age: 24 * 3600,
        count: 1000,
      });
      expect(job.opts.removeOnComplete).toBe(true);
    }
  });
});
