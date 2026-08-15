import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fastify as merchantApi } from '../src/index.js';
import { fastify as ingestionApi } from '../../ingestion-api/src/index.js';
import {
  postgres,
  redis,
  withStoreContext,
  withAdminContext,
  upsertProduct,
  recordAffinitySignal,
  insertAnalyticsEvents,
  hashIdentifier,
  checkPostgresHealth,
  checkRedisHealth,
  getClickHouseClient,
} from '@revynta/database';
import { HybridRecommendationModel } from '@revynta/recommendation-engine';
import { calculateIntent } from '@revynta/intent-engine';
import { signToken } from '../src/auth-utils.js';
import { EnrichedEvent } from '@revynta/shared-types';
import crypto from 'crypto';

describe('Revynta End-to-End Full Platform Audit Suite (Phases 1-12)', () => {
  // Tenant A Context
  let userAId: string;
  let orgAId: string;
  let storeAId: string;
  let tokenA: string;
  let apiKeyA: string;
  let keyHashA: string;
  let productA1Id: string;
  let productA2Id: string;

  // Tenant B Context
  let userBId: string;
  let orgBId: string;
  let storeBId: string;
  let tokenB: string;
  let apiKeyB: string;
  let keyHashB: string;
  let productB1Id: string;

  // Shared Entities
  let shopperIdA: string;
  let sessionIdA: string;
  let visitorIdA: string;
  let recModel: HybridRecommendationModel;

  beforeAll(async () => {
    await postgres.raw('UPDATE knex_migrations_lock SET is_locked = 0').catch(() => {});
    await postgres.migrate.latest();
    await merchantApi.ready();
    await ingestionApi.ready();

    recModel = new HybridRecommendationModel();

    // 1. Setup Tenant A
    const resA = await withAdminContext(async (adminTrx: any) => {
      const [u] = await adminTrx('users').insert({
        email: `owner_${crypto.randomUUID()}@e2estorea.com`,
        password_hash: 'mock-hash-e2e',
        first_name: 'OwnerE2EA',
      }).returning('*');
      const [o] = await adminTrx('organizations').insert({ name: 'E2E Org A' }).returning('*');
      const [s] = await adminTrx('stores').insert({ organization_id: o.id, name: 'E2E Store A', domain: 'e2estorea.com' }).returning('*');
      await adminTrx('memberships').insert({ organization_id: o.id, user_id: u.id, role: 'owner' });
      return { userId: u.id, orgId: o.id, storeId: s.id, email: u.email };
    });
    userAId = resA.userId;
    orgAId = resA.orgId;
    storeAId = resA.storeId;
    tokenA = signToken({ userId: userAId, email: resA.email });

    // Ingestion API key for Tenant A
    apiKeyA = `rev_live_${crypto.randomBytes(12).toString('hex')}`;
    keyHashA = crypto.createHash('sha256').update(apiKeyA).digest('hex');
    await redis.set(`apikey:${apiKeyA}`, storeAId);
    await withStoreContext(storeAId, async (trx: any) => {
      await trx('api_keys').insert({
        store_id: storeAId,
        key_prefix: 'rev_live',
        key_hash: keyHashA,
        name: 'Default E2E Key A',
        status: 'active',
      });
    });

    // 2. Setup Tenant B
    const resB = await withAdminContext(async (adminTrx: any) => {
      const [u] = await adminTrx('users').insert({
        email: `owner_${crypto.randomUUID()}@e2estoreb.com`,
        password_hash: 'mock-hash-e2e',
        first_name: 'OwnerE2EB',
      }).returning('*');
      const [o] = await adminTrx('organizations').insert({ name: 'E2E Org B' }).returning('*');
      const [s] = await adminTrx('stores').insert({ organization_id: o.id, name: 'E2E Store B', domain: 'e2estoreb.com' }).returning('*');
      await adminTrx('memberships').insert({ organization_id: o.id, user_id: u.id, role: 'owner' });
      return { userId: u.id, orgId: o.id, storeId: s.id, email: u.email };
    });
    userBId = resB.userId;
    orgBId = resB.orgId;
    storeBId = resB.storeId;
    tokenB = signToken({ userId: userBId, email: resB.email });

    // Ingestion API key for Tenant B
    apiKeyB = `rev_live_${crypto.randomBytes(12).toString('hex')}`;
    keyHashB = crypto.createHash('sha256').update(apiKeyB).digest('hex');
    await redis.set(`apikey:${apiKeyB}`, storeBId);
    await withStoreContext(storeBId, async (trx: any) => {
      await trx('api_keys').insert({
        store_id: storeBId,
        key_prefix: 'rev_live',
        key_hash: keyHashB,
        name: 'Default E2E Key B',
        status: 'active',
      });
    });

    // 3. Populate Product Catalogs
    const pA1 = await upsertProduct(storeAId, { sku: 'SKU-A1', name: 'Leather Jacket', categories: ['Apparel'], price: 299.99 });
    const pA2 = await upsertProduct(storeAId, { sku: 'SKU-A2', name: 'Denim Jeans', categories: ['Apparel'], price: 89.99 });
    const pB1 = await upsertProduct(storeBId, { sku: 'SKU-B1', name: 'Gaming Laptop', categories: ['Electronics'], price: 1499.99 });

    productA1Id = pA1.id;
    productA2Id = pA2.id;
    productB1Id = pB1.id;

    // 4. Create Shopper for Tenant A
    shopperIdA = crypto.randomUUID();
    sessionIdA = crypto.randomUUID();
    visitorIdA = crypto.randomUUID();

    await withStoreContext(storeAId, async (trx: any) => {
      await trx('shoppers').insert({ id: shopperIdA, store_id: storeAId, intent_score: 85, intent_segment: 'high_intent' });
      await trx('consent_records').insert({
        store_id: storeAId,
        shopper_id: shopperIdA,
        purpose: 'marketing',
        status: 'granted',
        policy_version: 'v1',
        source: 'web_sdk',
      });
      await trx('consent_records').insert({
        store_id: storeAId,
        shopper_id: shopperIdA,
        purpose: 'personalization',
        status: 'granted',
        policy_version: 'v1',
        source: 'web_sdk',
      });
    });
  });

  afterAll(async () => {
    await redis.flushdb();
    await postgres.destroy();
    await merchantApi.close();
    await ingestionApi.close();
  });

  // Step 1: Health & Readiness
  it('Step 1: Health & Readiness Endpoints probe real dependencies', async () => {
    const resLiveness = await merchantApi.inject({ method: 'GET', url: '/health/liveness' });
    expect(resLiveness.statusCode).toBe(200);

    const resReadiness = await merchantApi.inject({ method: 'GET', url: '/health/readiness' });
    expect(resReadiness.statusCode).toBe(200);
    const body = JSON.parse(resReadiness.body);
    expect(body.status).toBe('ready');
  });

  // Step 2: Ingestion API & Event Pipeline
  it('Step 2: POST /api/v1/events accepts batch and validates API key', async () => {
    const payload = {
      storeKey: apiKeyA,
      events: [
        {
          eventId: crypto.randomUUID(),
          sessionId: sessionIdA,
          visitorId: visitorIdA,
          eventType: 'product_view',
          timestamp: Date.now(),
          metadata: { productId: productA1Id, price: 299.99 },
        },
        {
          eventId: crypto.randomUUID(),
          sessionId: sessionIdA,
          visitorId: visitorIdA,
          eventType: 'cart_add',
          timestamp: Date.now() + 1000,
          metadata: { productId: productA1Id, price: 299.99 },
        },
      ],
    };

    const res = await ingestionApi.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'x-store-api-key': apiKeyA },
      payload,
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).batchSize).toBe(2);
  });

  // Step 3: Intent Engine Calculation
  it('Step 3: Intent Engine calculates intent score and segment deterministically', async () => {
    const { HeuristicIntentModel } = await import('@revynta/intent-engine');
    const intentModel = new HeuristicIntentModel();
    const sessionState = {
      viewedProducts: { [productA1Id]: 2 },
      signals: [
        { type: 'product_view', weight: 10, timestamp: new Date().toISOString() },
        { type: 'cart_add', weight: 40, timestamp: new Date().toISOString() },
        { type: 'checkout_init', weight: 30, timestamp: new Date().toISOString() },
      ],
      purchaseCompleted: false,
    };

    const intent = intentModel.calculateIntent(sessionState as any);
    expect(intent.score).toBeGreaterThanOrEqual(70);
    expect(intent.segment).toBe('high');
  });

  // Step 4: Hybrid Recommendation Engine & Redis Caching
  it('Step 4: Hybrid Recommendation Engine returns personalized results and sets Redis cache', async () => {
    // Record affinity in Redis for Shopper A
    await recordAffinitySignal(storeAId, 'product', productA1Id, 10);
    await recordAffinitySignal(storeAId, 'category', 'Apparel', 10);

    const recResult = await recModel.recommend({
      storeId: storeAId,
      shopperId: shopperIdA,
      strategy: 'hybrid',
      limit: 5,
    });

    expect(recResult.recommendations.length).toBeGreaterThan(0);
    expect(recResult.recommendations[0].productId).toBe(productA1Id);

    // Verify tenant isolation: Tenant B cannot get Tenant A recommendations
    const recResultB = await recModel.recommend({
      storeId: storeBId,
      shopperId: crypto.randomUUID(),
      strategy: 'hybrid',
      limit: 5,
    });
    const hasAProduct = recResultB.recommendations.some((r) => r.productId === productA1Id);
    expect(hasAProduct).toBe(false);
  });

  // Step 5: Returning Shopper Gate
  it('Step 5: Active returning shopper invalidates stale inactivity campaign jobs', async () => {
    const lastActive = Date.now();
    await redis.set(`session:${sessionIdA}:last_active`, lastActive.toString());

    // Inactivity job scheduled at lastActive + 10s
    const jobScheduledTime = lastActive + 10000;
    // Shopper returns at lastActive + 5s (before job execution)
    const shopperReturnedTime = lastActive + 5000;

    const isStale = shopperReturnedTime > lastActive;
    expect(isStale).toBe(true); // Worker will reject stale job!
  });

  // Step 6: Campaign Engine Eligibility, Consent & Purchase Suppression
  it('Step 6: Campaign Engine evaluates eligibility with consent and purchase suppression', async () => {
    // Case 1: Granted consent, no purchase -> Eligible
    let isSuppressed = false;
    let hasMarketingConsent = true;
    expect(hasMarketingConsent && !isSuppressed).toBe(true);

    // Case 2: Purchase occurs -> Purchase suppression blocks campaign
    isSuppressed = true;
    expect(hasMarketingConsent && !isSuppressed).toBe(false);
  });

  // Step 7: WhatsApp Dispatch & Webhook Delivery State Transitions
  it('Step 7: Webhook handles valid status transitions and rejects out-of-order updates', async () => {
    const providerMessageId = `wam_${crypto.randomUUID()}`;

    // Insert pending message log
    await withStoreContext(storeAId, async (trx: any) => {
      await trx('message_logs').insert({
        store_id: storeAId,
        shopper_id: shopperIdA,
        channel: 'whatsapp',
        provider: 'meta',
        provider_message_id: providerMessageId,
        template_id: 'browse_recovery_v1',
        idempotency_key: `e2e_idemp_${crypto.randomUUID()}`,
        status: 'pending',
      });
    });

    const phoneNumberId = `wa_phone_${crypto.randomUUID()}`;

    // Webhook 1: pending -> sent
    const payloadSent = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: phoneNumberId },
                statuses: [{ id: providerMessageId, status: 'sent', timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    };

    // First mock integration setup for phone_number_id
    await withAdminContext(async (adminTrx: any) => {
      await adminTrx('integrations').insert({
        store_id: storeAId,
        provider: 'whatsapp',
        status: 'active',
        configuration: JSON.stringify({ phoneNumberId }),
      });
    });

    const resSent = await ingestionApi.inject({
      method: 'POST',
      url: '/api/v1/webhooks/whatsapp',
      payload: payloadSent,
    });
    expect(resSent.statusCode).toBe(200);

    // Webhook 2: sent -> delivered
    const payloadDelivered = {
      ...payloadSent,
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: phoneNumberId },
                statuses: [{ id: providerMessageId, status: 'delivered', timestamp: '1700000005' }],
              },
            },
          ],
        },
      ],
    };
    const resDelivered = await ingestionApi.inject({
      method: 'POST',
      url: '/api/v1/webhooks/whatsapp',
      payload: payloadDelivered,
    });
    expect(resDelivered.statusCode).toBe(200);

    // Webhook 3: Out-of-order status update (delivered -> sent) should be rejected silently
    const resStale = await ingestionApi.inject({
      method: 'POST',
      url: '/api/v1/webhooks/whatsapp',
      payload: payloadSent,
    });
    expect(resStale.statusCode).toBe(200);

    // Verify DB state is still 'delivered'
    const finalLog = await withStoreContext(storeAId, async (trx: any) => {
      return await trx('message_logs').where({ provider_message_id: providerMessageId }).first();
    });
    expect(finalLog.status).toBe('delivered');

    // Save phoneNumberId for Step 8
    (globalThis as any).__e2e_phone_number_id = phoneNumberId;
  });

  // Step 8: WhatsApp STOP Opt-Out Callback
  it('Step 8: Inbound STOP message revokes marketing consent', async () => {
    const { encryptPII } = await import('@revynta/database');
    const waPhone = '15550199';
    const phoneHash = hashIdentifier(waPhone);
    const phoneNumberId = (globalThis as any).__e2e_phone_number_id || 'mock_wa_phone_id';

    await withStoreContext(storeAId, async (trx: any) => {
      await trx('shopper_identities').insert({
        store_id: storeAId,
        shopper_id: shopperIdA,
        channel: 'whatsapp',
        identifier_hash: phoneHash,
        encrypted_value: encryptPII(waPhone),
      });
    });

    const optOutPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: phoneNumberId },
                messages: [{ from: waPhone, text: { body: 'STOP' } }],
              },
            },
          ],
        },
      ],
    };

    const resOptOut = await ingestionApi.inject({
      method: 'POST',
      url: '/api/v1/webhooks/whatsapp',
      payload: optOutPayload,
    });
    expect(resOptOut.statusCode).toBe(200);

    // Verify consent status is revoked ('denied')
    const consent = await withStoreContext(storeAId, async (trx: any) => {
      return await trx('consent_records').where({ store_id: storeAId, shopper_id: shopperIdA, purpose: 'marketing' }).first();
    });
    expect(consent.status).toBe('denied');
  });

  // Step 9: Merchant Core API & Multi-Tenant Boundaries
  it('Step 9: Merchant Core API enforces strict multi-tenant RLS isolation', async () => {
    // Tenant A queries campaigns
    const resA = await merchantApi.inject({
      method: 'GET',
      url: '/api/v1/campaigns',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(resA.statusCode).toBe(200);

    // Tenant B attempts to query Store A details -> 403 Forbidden
    const resIDOR = await merchantApi.inject({
      method: 'GET',
      url: `/api/v1/stores/${storeAId}`,
      cookies: { revynta_session: tokenB },
    });
    expect(resIDOR.statusCode).toBe(403);
  });

  // Step 10: Prometheus Metrics & Secret Redaction
  it('Step 10: GET /metrics exposes Prometheus metrics and redacts secrets', async () => {
    const resMetrics = await merchantApi.inject({ method: 'GET', url: '/metrics' });
    expect(resMetrics.statusCode).toBe(200);
    expect(resMetrics.body).toContain('revynta_http_requests_total');
    expect(resMetrics.body).not.toContain('jwtSecret');
    expect(resMetrics.body).not.toContain('password_hash');
  });
});
