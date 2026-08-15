import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fastify } from '../src/index.js';
import {
  postgres,
  redis,
  withStoreContext,
  withAdminContext,
  insertMessageLog,
  getCampaignById,
  encryptPII,
  hashIdentifier,
} from '@revynta/database';
import { signToken } from '../src/auth-utils.js';
import crypto from 'crypto';

describe('Phase 10 - Merchant Core API Integration & Security Matrix', () => {
  async function setupTestShopper(storeId: string, phone: string, consent = 'granted'): Promise<string> {
    const shopperId = crypto.randomUUID();
    const phoneHash = hashIdentifier(phone);
    const encryptedPhone = encryptPII(phone);

    await withStoreContext(storeId, async (trx: any) => {
      await trx('shoppers').insert({
        id: shopperId,
        store_id: storeId,
        intent_score: 85,
        intent_segment: 'high',
      });
      await trx('shopper_identities').insert({
        store_id: storeId,
        shopper_id: shopperId,
        channel: 'whatsapp',
        identifier_hash: phoneHash,
        encrypted_value: encryptedPhone,
      });
      await trx('consent_records').insert({
        store_id: storeId,
        shopper_id: shopperId,
        purpose: 'marketing',
        status: consent,
        source: 'test',
        policy_version: 'v1',
      });
    });
    return shopperId;
  }
  let userAId: string;
  let orgAId: string;
  let storeAId: string;
  let tokenA: string;

  let userBId: string;
  let orgBId: string;
  let storeBId: string;
  let tokenB: string;

  let campaignAId: string;

  beforeAll(async () => {
    await postgres.raw('UPDATE knex_migrations_lock SET is_locked = 0').catch(() => {});
    await postgres.migrate.latest();
    await fastify.ready();

    // 1. Seed Tenant A records (owner role)
    const resA = await withAdminContext(async (adminTrx: any) => {
      const [u] = await adminTrx('users').insert({
        email: `owner_${crypto.randomUUID()}@storea.com`,
        password_hash: 'mock-hash',
        first_name: 'Owner',
        last_name: 'A',
      }).returning('*');

      const [o] = await adminTrx('organizations').insert({ name: 'Organization A' }).returning('*');
      const [s] = await adminTrx('stores').insert({
        organization_id: o.id,
        name: 'Store A',
        domain: 'storea.com',
      }).returning('*');

      await adminTrx('memberships').insert({
        organization_id: o.id,
        user_id: u.id,
        role: 'owner',
      });

      return { userId: u.id, orgId: o.id, storeId: s.id, email: u.email };
    });

    userAId = resA.userId;
    orgAId = resA.orgId;
    storeAId = resA.storeId;
    tokenA = signToken({ userId: userAId, email: resA.email });

    // 2. Seed Tenant B records (viewer role)
    const resB = await withAdminContext(async (adminTrx: any) => {
      const [u] = await adminTrx('users').insert({
        email: `viewer_${crypto.randomUUID()}@storeb.com`,
        password_hash: 'mock-hash',
        first_name: 'Viewer',
        last_name: 'B',
      }).returning('*');

      const [o] = await adminTrx('organizations').insert({ name: 'Organization B' }).returning('*');
      const [s] = await adminTrx('stores').insert({
        organization_id: o.id,
        name: 'Store B',
        domain: 'storeb.com',
      }).returning('*');

      await adminTrx('memberships').insert({
        organization_id: o.id,
        user_id: u.id,
        role: 'viewer',
      });

      return { userId: u.id, orgId: o.id, storeId: s.id, email: u.email };
    });

    userBId = resB.userId;
    orgBId = resB.orgId;
    storeBId = resB.storeId;
    tokenB = signToken({ userId: userBId, email: resB.email });
  });

  afterAll(async () => {
    await redis.flushdb();
    await postgres.destroy();
    await fastify.close();
  });

  // ─── Section 1: Authentication ──────────────────────────────────────────

  it('1. Unauthenticated request returns 401', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('2. Authenticated merchant fetches own profile and store list', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { revynta_session: tokenA },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.userId).toBe(userAId);
    expect(body.data.activeStoreId).toBe(storeAId);
    expect(body.data.passwordHash).toBeUndefined();
    expect(body.data.password_hash).toBeUndefined();

    const storeRes = await fastify.inject({
      method: 'GET',
      url: '/api/v1/stores',
      cookies: { revynta_session: tokenA },
    });
    expect(storeRes.statusCode).toBe(200);
    const storeBody = JSON.parse(storeRes.body);
    expect(storeBody.data.length).toBe(1);
    expect(storeBody.data[0].id).toBe(storeAId);
  });

  it('3. IDOR Check: Tenant A cannot access Tenant B store details', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/v1/stores/${storeBId}`,
      cookies: { revynta_session: tokenA },
    });
    expect(res.statusCode).toBe(403);
  });

  it('4. IDOR via x-store-id header: Tenant A cannot access Tenant B campaigns', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/campaigns',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeBId },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Section 2: Campaign Management ──────────────────────────────────────

  it('5. Campaign CRUD & RBAC checks', async () => {
    const resCreate = await fastify.inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
      payload: {
        name: 'Browse Abandonment Recovery Campaign',
        triggerType: 'browse_abandonment',
        inactivityDurationMinutes: 30,
        minIntentScore: 75,
        communicationChannel: 'whatsapp',
        templateId: 'browse-recovery-template',
        cooldownSeconds: 3600,
      },
    });
    expect(resCreate.statusCode).toBe(201);
    const campaign = JSON.parse(resCreate.body).data;
    campaignAId = campaign.id;
    expect(campaign.status).toBe('paused');
    expect(campaign.store_id).toBe(storeAId);

    // Invalid inputs rejected with 422
    const resInvalid = await fastify.inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
      payload: {
        name: 'Invalid Campaign',
        triggerType: 'browse_abandonment',
        inactivityDurationMinutes: -5,
        minIntentScore: 120,
        communicationChannel: 'whatsapp',
        templateId: 'temp',
        cooldownSeconds: 0,
      },
    });
    expect(resInvalid.statusCode).toBe(422);

    // Viewer (User B) cannot toggle campaign A - IDOR blocked first
    const resToggleViewer = await fastify.inject({
      method: 'POST',
      url: `/api/v1/campaigns/${campaignAId}/toggle`,
      cookies: { revynta_session: tokenB },
      headers: { 'x-store-id': storeAId },
    });
    expect(resToggleViewer.statusCode).toBe(403);

    // Owner toggles campaign (paused -> active)
    const resToggle = await fastify.inject({
      method: 'POST',
      url: `/api/v1/campaigns/${campaignAId}/toggle`,
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(resToggle.statusCode).toBe(200);
    expect(JSON.parse(resToggle.body).data.status).toBe('active');

    // Owner archives campaign (soft delete)
    const resDelete = await fastify.inject({
      method: 'DELETE',
      url: `/api/v1/campaigns/${campaignAId}`,
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(resDelete.statusCode).toBe(200);

    // Archived campaign excluded from active list
    const resList = await fastify.inject({
      method: 'GET',
      url: '/api/v1/campaigns',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    const campaignsList = JSON.parse(resList.body).data;
    expect(campaignsList.find((c: any) => c.id === campaignAId)).toBeUndefined();
  });

  it('6. Campaign message history preserved after soft delete/archive', async () => {
    const resCreate = await fastify.inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
      payload: {
        name: 'Archive History Campaign',
        triggerType: 'browse_abandonment',
        inactivityDurationMinutes: 15,
        minIntentScore: 60,
        communicationChannel: 'whatsapp',
        templateId: 'history-test',
        cooldownSeconds: 3600,
      },
    });
    const histCampaignId = JSON.parse(resCreate.body).data.id;

    const shopperId = await setupTestShopper(storeAId, `+1500${Math.floor(1000000 + Math.random() * 9000000)}`);
    await insertMessageLog(storeAId, {
      store_id: storeAId,
      shopper_id: shopperId,
      campaign_id: histCampaignId,
      channel: 'whatsapp',
      provider: 'mock',
      provider_message_id: 'wamid.HistTest_' + crypto.randomUUID(),
      template_id: 'history-test',
      status: 'delivered',
      idempotency_key: `eligible:${histCampaignId}:${shopperId}:${crypto.randomUUID()}:day1`,
    });

    await fastify.inject({
      method: 'DELETE',
      url: `/api/v1/campaigns/${histCampaignId}`,
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });

    // Message log must still exist even after campaign is archived
    const logs = await withStoreContext(storeAId, async (trx: any) => {
      return await trx('message_logs').where({ campaign_id: histCampaignId });
    });
    expect(logs.length).toBe(1);
    expect(logs[0].status).toBe('delivered');
  });

  it('7. Campaign update - valid and invalid inputs', async () => {
    const resCreate = await fastify.inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
      payload: {
        name: 'Update Test Campaign',
        triggerType: 'browse_abandonment',
        inactivityDurationMinutes: 30,
        minIntentScore: 50,
        communicationChannel: 'whatsapp',
        templateId: 'test-template',
        cooldownSeconds: 1800,
      },
    });
    const updateCampId = JSON.parse(resCreate.body).data.id;

    // Valid update
    const resUpdate = await fastify.inject({
      method: 'PUT',
      url: `/api/v1/campaigns/${updateCampId}`,
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
      payload: { name: 'Updated Campaign Name', minIntentScore: 80 },
    });
    expect(resUpdate.statusCode).toBe(200);
    expect(JSON.parse(resUpdate.body).data.name).toBe('Updated Campaign Name');

    // Invalid update - negative inactivity
    const resInvalidUpdate = await fastify.inject({
      method: 'PUT',
      url: `/api/v1/campaigns/${updateCampId}`,
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
      payload: { inactivityDurationMinutes: -1 },
    });
    expect(resInvalidUpdate.statusCode).toBe(422);

    // Cross-tenant update attempt
    const resCrossTenant = await fastify.inject({
      method: 'PUT',
      url: `/api/v1/campaigns/${updateCampId}`,
      cookies: { revynta_session: tokenB },
      headers: { 'x-store-id': storeAId },
      payload: { name: 'Hacked Campaign Name' },
    });
    expect(resCrossTenant.statusCode).toBe(403);
  });

  // ─── Section 3: API Key Management ──────────────────────────────────────

  it('8. API Key management & display-once security', async () => {
    const resCreate = await fastify.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
      payload: { name: 'Production SDK Key' },
    });
    expect(resCreate.statusCode).toBe(201);
    const keyData = JSON.parse(resCreate.body).data;
    expect(keyData.rawKey).toBeDefined();
    expect(keyData.rawKey.startsWith('rev_live_')).toBe(true);
    const createdKeyId = keyData.id;

    // List API keys - rawKey must NOT be returned!
    const resList = await fastify.inject({
      method: 'GET',
      url: '/api/v1/api-keys',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(resList.statusCode).toBe(200);
    const keys = JSON.parse(resList.body).data;
    const foundKey = keys.find((k: any) => k.id === createdKeyId);
    expect(foundKey).toBeDefined();
    expect(foundKey.rawKey).toBeUndefined();
    expect(foundKey.key_hash).toBeUndefined();
    expect(foundKey.key_prefix).toBeDefined();

    // Verify raw key is NOT stored - only hash in DB
    const dbKey = await withStoreContext(storeAId, async (trx: any) => {
      return await trx('api_keys').where({ id: createdKeyId }).first();
    });
    expect(dbKey.key_hash).toBeDefined();
    expect(dbKey.key_hash).not.toBe(keyData.rawKey);

    // Revoke API key
    const resRevoke = await fastify.inject({
      method: 'DELETE',
      url: `/api/v1/api-keys/${createdKeyId}`,
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(resRevoke.statusCode).toBe(200);

    const revokedKey = await withStoreContext(storeAId, async (trx: any) => {
      return await trx('api_keys').where({ id: createdKeyId }).first();
    });
    expect(revokedKey.status).toBe('revoked');
    expect(revokedKey.revoked_at).toBeDefined();
  });

  it('9. API Key tenant isolation - cross-tenant revocation blocked via RLS', async () => {
    const resCreate = await fastify.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
      payload: { name: 'Isolation Test Key' },
    });
    const keyId = JSON.parse(resCreate.body).data.id;

    // Tenant B (viewer role) tries to revoke Tenant A's key using Tenant B's store context.
    // A viewer role triggers RBAC rejection (403) before store-level RLS is even evaluated.
    // Both 403 (RBAC) and 404 (RLS-based isolation) are valid - both prove cross-tenant access is blocked.
    const resRevokeAttempt = await fastify.inject({
      method: 'DELETE',
      url: `/api/v1/api-keys/${keyId}`,
      cookies: { revynta_session: tokenB },
      headers: { 'x-store-id': storeBId },
    });
    // Viewer role is blocked by RBAC (403) before store-scoped query would return 404
    expect([403, 404]).toContain(resRevokeAttempt.statusCode);
  });

  // ─── Section 4: WhatsApp Integration ────────────────────────────────

  it('10. WhatsApp connection & credential masking', async () => {
    const resConnect = await fastify.inject({
      method: 'POST',
      url: '/api/v1/integrations/whatsapp',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
      payload: {
        phoneNumberId: '109677328511',
        accessToken: 'mock-access-token-secret-val',
        isMock: true,
      },
    });
    expect(resConnect.statusCode).toBe(200);
    const connectBody = JSON.parse(resConnect.body).data;
    expect(connectBody.accessToken).toBeUndefined();
    expect(connectBody.accessTokenEncrypted).toBeUndefined();

    const resGet = await fastify.inject({
      method: 'GET',
      url: '/api/v1/integrations/whatsapp',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(resGet.statusCode).toBe(200);
    const integration = JSON.parse(resGet.body).data;
    expect(integration.phoneNumberId).toBe('109677328511');
    expect(integration.accessTokenEncrypted).toBeUndefined();
    expect(integration.accessToken).toBeUndefined();

    // Verify token is stored encrypted in DB
    const dbRow = await withStoreContext(storeAId, async (trx: any) => {
      return await trx('integrations').where({ store_id: storeAId, provider: 'whatsapp' }).first();
    });
    expect(dbRow.configuration.accessTokenEncrypted).toBeDefined();
    expect(dbRow.configuration.accessTokenEncrypted).not.toBe('mock-access-token-secret-val');
  });

  it('11. WhatsApp integration tenant isolation', async () => {
    const resB = await fastify.inject({
      method: 'GET',
      url: '/api/v1/integrations/whatsapp',
      cookies: { revynta_session: tokenB },
      headers: { 'x-store-id': storeBId },
    });
    expect(resB.statusCode).toBe(200);
    const dataB = JSON.parse(resB.body).data;
    expect(dataB).toBeNull(); // B has no integration, and cannot see A's!
  });

  // ─── Section 5: Analytics & Messages ─────────────────────────────────

  it('12. Paginated Message Logs & Analytics overviews', async () => {
    const shopperId = await setupTestShopper(storeAId, '+15005559999');

    const campaignId = crypto.randomUUID();
    await withStoreContext(storeAId, async (trx: any) => {
      await trx('campaigns').insert({
        id: campaignId,
        store_id: storeAId,
        name: 'Temp Analytics Campaign',
        status: 'active',
        trigger_type: 'browse_abandonment',
        inactivity_duration_minutes: 15,
        min_intent_score: 70,
        communication_channel: 'whatsapp',
        template_id: 'temp',
        cooldown_seconds: 5,
      });
    });

    await insertMessageLog(storeAId, {
      store_id: storeAId,
      shopper_id: shopperId,
      campaign_id: campaignId,
      channel: 'whatsapp',
      provider: 'mock',
      provider_message_id: 'wamid.Mock_' + crypto.randomUUID(),
      template_id: 'temp',
      status: 'read',
      idempotency_key: `eligible:${campaignId}:${shopperId}:${crypto.randomUUID()}:day1`,
    });

    // Fetch paginated messages (recipient phone numbers must be masked/excluded)
    const resMessages = await fastify.inject({
      method: 'GET',
      url: '/api/v1/messages?page=1&limit=10',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(resMessages.statusCode).toBe(200);
    const messages = JSON.parse(resMessages.body).data;
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].recipientPhone).toBeUndefined();

    // Fetch overview stats
    const resOverview = await fastify.inject({
      method: 'GET',
      url: '/api/v1/analytics/overview',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(resOverview.statusCode).toBe(200);
    const stats = JSON.parse(resOverview.body).data;
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.read).toBeGreaterThanOrEqual(1);
    // Delivery rate = (delivered + read) / total
    expect(stats.deliveryRate).toBe(parseFloat(((stats.delivered + stats.read) / stats.total).toFixed(4)));
  });

  it('13. Analytics tenant isolation - metrics do not leak across tenants', async () => {
    const overviewA = await fastify.inject({
      method: 'GET',
      url: '/api/v1/analytics/overview',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    const overviewB = await fastify.inject({
      method: 'GET',
      url: '/api/v1/analytics/overview',
      cookies: { revynta_session: tokenB },
      headers: { 'x-store-id': storeBId },
    });

    const statsA = JSON.parse(overviewA.body).data;
    const statsB = JSON.parse(overviewB.body).data;

    // Store B has no message logs
    expect(statsB.total).toBe(0);
    // Store A has at least 1 log
    expect(statsA.total).toBeGreaterThanOrEqual(1);
    expect(statsA.total).not.toBe(statsB.total);
  });

  it('14. Audit logs are tenant-scoped and require admin/owner role', async () => {
    // Owner can access audit logs
    const resOwner = await fastify.inject({
      method: 'GET',
      url: '/api/v1/audit-logs',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(resOwner.statusCode).toBe(200);
    const logsA = JSON.parse(resOwner.body).data;
    for (const log of logsA) {
      expect(log.organization_id).toBe(orgAId);
    }

    // Viewer role cannot access audit logs
    const resViewer = await fastify.inject({
      method: 'GET',
      url: '/api/v1/audit-logs',
      cookies: { revynta_session: tokenB },
      headers: { 'x-store-id': storeBId },
    });
    expect(resViewer.statusCode).toBe(403);
  });

  it('15. Intent analytics returns segment distribution for tenant', async () => {
    await withStoreContext(storeAId, async (trx: any) => {
      await trx('shoppers').insert([
        { store_id: storeAId, intent_score: 10, intent_segment: 'low' },
        { store_id: storeAId, intent_score: 50, intent_segment: 'medium' },
        { store_id: storeAId, intent_score: 90, intent_segment: 'high' },
      ]);
    });

    const resIntent = await fastify.inject({
      method: 'GET',
      url: '/api/v1/analytics/intent',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(resIntent.statusCode).toBe(200);
    const distribution = JSON.parse(resIntent.body).data;
    expect(distribution.low).toBeGreaterThanOrEqual(1);
    expect(distribution.medium).toBeGreaterThanOrEqual(1);
    expect(distribution.high).toBeGreaterThanOrEqual(1);

    // Tenant B gets separate/empty distribution
    const resIntentB = await fastify.inject({
      method: 'GET',
      url: '/api/v1/analytics/intent',
      cookies: { revynta_session: tokenB },
      headers: { 'x-store-id': storeBId },
    });
    expect(resIntentB.statusCode).toBe(200);
    const distB = JSON.parse(resIntentB.body).data;
    expect(distB.high).toBe(0);
  });

  it('16. Campaign analytics returns per-campaign message stats', async () => {
    const resAnalytics = await fastify.inject({
      method: 'GET',
      url: '/api/v1/analytics/campaigns',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(resAnalytics.statusCode).toBe(200);
    const stats = JSON.parse(resAnalytics.body).data;
    expect(Array.isArray(stats)).toBe(true);
    for (const s of stats) {
      expect(s.campaignId).toBeDefined();
      expect(typeof s.total).toBe('number');
    }
  });

  // ─── Section 6: Login flow ────────────────────────────────────────────

  it('17. Register and Login flow works correctly', async () => {
    const testEmail = `newmerchant_${crypto.randomUUID()}@test.com`;
    const testPassword = 'SecureP@ssw0rd!';

    const resRegister = await fastify.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: testEmail,
        password: testPassword,
        firstName: 'Test',
        lastName: 'Merchant',
        organizationName: 'Test Organization',
        storeName: 'Test Store',
        storeDomain: `test-${crypto.randomUUID()}.com`,
      },
    });
    expect(resRegister.statusCode).toBe(201);
    expect(resRegister.headers['set-cookie']).toBeDefined();

    const resLogin = await fastify.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: testEmail, password: testPassword },
    });
    expect(resLogin.statusCode).toBe(200);
    expect(resLogin.headers['set-cookie']).toBeDefined();

    // Wrong password rejected
    const resWrongPwd = await fastify.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: testEmail, password: 'wrongpassword' },
    });
    expect(resWrongPwd.statusCode).toBe(401);

    // Duplicate registration
    const resDuplicate = await fastify.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: testEmail,
        password: testPassword,
        organizationName: 'Duplicate Org',
        storeName: 'Duplicate Store',
        storeDomain: 'dup.com',
      },
    });
    expect(resDuplicate.statusCode).toBe(409);
  });

  it('18. Logout clears session cookie', async () => {
    const resLogout = await fastify.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { revynta_session: tokenA },
    });
    expect(resLogout.statusCode).toBe(200);
    const setCookieHeader = resLogout.headers['set-cookie'];
    expect(setCookieHeader).toBeDefined();
  });

  // ─── Section 7: Campaign preview ────────────────────────────────────

  it('19. Campaign preview returns safe configuration (no PII)', async () => {
    const resCreate = await fastify.inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
      payload: {
        name: 'Preview Test Campaign',
        triggerType: 'browse_abandonment',
        inactivityDurationMinutes: 20,
        minIntentScore: 65,
        communicationChannel: 'whatsapp',
        templateId: 'preview-template',
        cooldownSeconds: 1800,
      },
    });
    const previewCampaignId = JSON.parse(resCreate.body).data.id;

    const resPreview = await fastify.inject({
      method: 'GET',
      url: `/api/v1/campaigns/${previewCampaignId}/preview`,
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(resPreview.statusCode).toBe(200);
    const preview = JSON.parse(resPreview.body).data;
    expect(preview.campaignName).toBe('Preview Test Campaign');
    expect(preview.intentThreshold).toBe(65);
    expect(typeof preview.estimatedMatchingShoppers).toBe('number');
    // Must NOT expose individual shopper data
    expect(preview.shoppers).toBeUndefined();
    expect(preview.shopperIds).toBeUndefined();
  });

  // ─── Section 8: Response format ────────────────────────────────────

  it('20. Error responses have consistent structure', async () => {
    const res401 = await fastify.inject({ method: 'GET', url: '/api/v1/campaigns' });
    const body401 = JSON.parse(res401.body);
    expect(body401.error).toBeDefined();
    expect(body401.error.code).toBeDefined();
    expect(body401.error.message).toBeDefined();
    expect(body401.stack).toBeUndefined();
    expect(JSON.stringify(body401)).not.toContain('at Object.');

    const res403 = await fastify.inject({
      method: 'GET',
      url: `/api/v1/stores/${storeBId}`,
      cookies: { revynta_session: tokenA },
    });
    const body403 = JSON.parse(res403.body);
    expect(body403.error.code).toBe('FORBIDDEN');
  });

  it('21. Password hash never exposed in any API response', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { revynta_session: tokenA },
    });
    const bodyStr = res.body;
    expect(bodyStr).not.toContain('password_hash');
    expect(bodyStr).not.toContain('passwordHash');
    expect(bodyStr).not.toContain('mock-hash');
  });
});
