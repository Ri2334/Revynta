import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  redis,
  postgres,
  sessionKey,
  withStoreContext,
  encryptPII,
  hashIdentifier,
  insertMessageLog,
  getCampaignById,
  recordPurchaseSuppression,
  withAdminContext,
} from '@revynta/database';
import { start as startDispatcher, stop as stopDispatcher } from '../src/consumers/whatsapp-dispatcher.js';
import { producer, kafka } from '../src/kafka-client.js';
import { fastify } from '../../../apps/ingestion-api/src/index.js';
import crypto from 'crypto';

describe('Phase 9 - WhatsApp Gateway Integration Matrix', () => {
  const storeA = '11111111-1111-1111-1111-111111111119';
  const storeB = '22222222-2222-2222-2222-222222222229';
  const orgId = '33333333-3333-3333-3333-333333333339';

  let campaignAId = '66666666-6666-6666-6666-666666666669';

  async function setupTestShopper(storeId: string, phone: string, consent = 'granted'): Promise<string> {
    const shopperId = crypto.randomUUID();
    const phoneHash = hashIdentifier(phone);
    const encryptedPhone = encryptPII(phone);

    await withStoreContext(storeId, async (trx) => {
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

  async function setupWhatsAppIntegration(storeId: string, phoneId: string, isMock = true, extraConfig = {}): Promise<void> {
    const encryptedToken = encryptPII('mock-access-token');
    const configuration = {
      phoneNumberId: phoneId,
      accessTokenEncrypted: encryptedToken,
      isMock,
      ...extraConfig,
    };

    await withStoreContext(storeId, async (trx) => {
      // Delete existing rows first to ensure idempotency across test runs
      await trx('integrations').where({ store_id: storeId, provider: 'whatsapp' }).delete();
      await trx('integrations').insert({
        store_id: storeId,
        provider: 'whatsapp',
        configuration,
        status: 'active',
      });
    });
  }

  beforeAll(async () => {
    // Ensure Ingestion API Fastify server is fully bootstrapped
    await fastify.ready();

    // Run DB migrations
    await postgres.raw('UPDATE knex_migrations_lock SET is_locked = 0').catch(() => {});
    await postgres.migrate.latest();

    await postgres.raw(`INSERT INTO organizations (id, name) VALUES ('${orgId}', 'Phase9 Org') ON CONFLICT DO NOTHING;`);
    await postgres.raw(`INSERT INTO stores (id, organization_id, name, domain) VALUES ('${storeA}', '${orgId}', 'Store A', 'a.com') ON CONFLICT DO NOTHING;`);
    await postgres.raw(`INSERT INTO stores (id, organization_id, name, domain) VALUES ('${storeB}', '${orgId}', 'Store B', 'b.com') ON CONFLICT DO NOTHING;`);

    // Seed active campaign for Store A
    await withStoreContext(storeA, async (trx) => {
      await trx('campaigns').insert({
        id: campaignAId,
        store_id: storeA,
        name: 'Browse Abandonment WhatsApp',
        status: 'active',
        trigger_type: 'browse_abandonment',
        inactivity_duration_minutes: 15,
        min_intent_score: 70,
        communication_channel: 'whatsapp',
        template_id: 'browse-recovery-whatsapp',
        cooldown_seconds: 5,
      }).onConflict().ignore();
    });

    // Purge ALL stale integration rows matching either phoneNumberId from previous test runs.
    // We must clean globally (not just for storeA/storeB) because previous runs may have inserted
    // rows with different store UUIDs, causing withAdminContext to route webhooks to the wrong store.
    await withAdminContext(async (adminTrx) => {
      await adminTrx('integrations')
        .whereRaw("configuration->>'phoneNumberId' IN (?, ?)", ['109677328511', '109677328522'])
        .delete();
    });

    // Seed integrations for Store A and Store B
    await setupWhatsAppIntegration(storeA, '109677328511');
    await setupWhatsAppIntegration(storeB, '109677328522');

    // Start dispatcher consumer
    await startDispatcher();
  });

  afterAll(async () => {
    await stopDispatcher();
    await redis.flushdb();
    await postgres.destroy();
    await fastify.close();
  });

  it('A. Successful campaign delivery dispatch', async () => {
    const shopperId = await setupTestShopper(storeA, '+15005550009');
    const messageLogId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    // 1. Pre-insert message log as Campaign Engine would do
    await insertMessageLog(storeA, {
      store_id: storeA,
      shopper_id: shopperId,
      campaign_id: campaignAId,
      channel: 'whatsapp',
      provider: 'mock',
      provider_message_id: null,
      template_id: 'browse-recovery-whatsapp',
      status: 'pending',
      idempotency_key: `eligible:${campaignAId}:${shopperId}:${sessionId}:day1`,
      sent_at: null,
    });

    // We fetch the logged record to confirm ID mapping
    const logs = await withStoreContext(storeA, async (trx) => {
      return await trx('message_logs').where({ store_id: storeA, shopper_id: shopperId }).first();
    });
    expect(logs).toBeDefined();

    const actionPayload = {
      tenantId: storeA,
      sessionId,
      shopperId,
      campaignId: campaignAId,
      messageLogId: logs.id,
      identity: { channel: 'whatsapp', encryptedValue: encryptPII('+15005550009') },
      templateId: 'browse-recovery-whatsapp',
      affinityContext: { topProduct: 'Shoes', topCategory: 'Footwear' },
    };

    // Publish campaign eligible event to Kafka
    await producer.send({
      topic: 'events.campaign.eligible',
      messages: [{ key: shopperId, value: JSON.stringify(actionPayload) }],
    });

    // Wait for consumer delivery
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Verify log updated to 'sent' with providerMessageId
    const updatedLog = await withStoreContext(storeA, async (trx) => {
      return await trx('message_logs').where({ id: logs.id }).first();
    });
    expect(updatedLog.status).toBe('sent');
    expect(updatedLog.provider_message_id).toBeDefined();
    expect(updatedLog.sent_at).toBeDefined();
  });

  it('B & C. Duplicate event and worker idempotency checks', async () => {
    const shopperId = await setupTestShopper(storeA, '+15005550010');
    const sessionId = crypto.randomUUID();
    
    const messageLogId = await insertMessageLog(storeA, {
      store_id: storeA,
      shopper_id: shopperId,
      campaign_id: campaignAId,
      channel: 'whatsapp',
      provider: 'mock',
      provider_message_id: null,
      template_id: 'browse-recovery-whatsapp',
      status: 'pending',
      idempotency_key: `eligible:${campaignAId}:${shopperId}:${sessionId}:day1`,
      sent_at: null,
    });

    const actionPayload = {
      tenantId: storeA,
      sessionId,
      shopperId,
      campaignId: campaignAId,
      messageLogId,
      identity: { channel: 'whatsapp', encryptedValue: encryptPII('+15005550010') },
      templateId: 'browse-recovery-whatsapp',
      affinityContext: { topProduct: 'Shoes' },
    };

    // Send twice to simulate Kafka duplicate delivery
    await producer.send({
      topic: 'events.campaign.eligible',
      messages: [
        { key: shopperId, value: JSON.stringify(actionPayload) },
        { key: shopperId, value: JSON.stringify(actionPayload) },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const finalLogs = await withStoreContext(storeA, async (trx) => {
      return await trx('message_logs').where({ shopper_id: shopperId });
    });
    // Should have only 1 log row and state remains sent (no duplicate calls/logs)
    expect(finalLogs.length).toBe(1);
    expect(finalLogs[0].status).toBe('sent');
  });

  it('D. Purchase after eligibility check suppresses send', async () => {
    const shopperId = await setupTestShopper(storeA, '+15005550011');
    const sessionId = crypto.randomUUID();

    const messageLogId = await insertMessageLog(storeA, {
      store_id: storeA,
      shopper_id: shopperId,
      campaign_id: campaignAId,
      channel: 'whatsapp',
      provider: 'mock',
      provider_message_id: null,
      template_id: 'browse-recovery-whatsapp',
      status: 'pending',
      idempotency_key: `eligible:${campaignAId}:${shopperId}:${sessionId}:day1`,
      sent_at: null,
    });

    // Simulate purchase suppression (durable Postgres records)
    await recordPurchaseSuppression(storeA, shopperId, 24, 'v1');

    const actionPayload = {
      tenantId: storeA,
      sessionId,
      shopperId,
      campaignId: campaignAId,
      messageLogId,
      identity: { channel: 'whatsapp', encryptedValue: encryptPII('+15005550011') },
      templateId: 'browse-recovery-whatsapp',
    };

    await producer.send({
      topic: 'events.campaign.eligible',
      messages: [{ key: shopperId, value: JSON.stringify(actionPayload) }],
    });

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const finalLog = await withStoreContext(storeA, async (trx) => {
      return await trx('message_logs').where({ id: messageLogId }).first();
    });
    // Final safety checks block dispatch! Status set to failed.
    expect(finalLog.status).toBe('failed');
    expect(finalLog.failure_reason).toContain('suppression');
  });

  it('E. Consent withdrawn blocks delivery', async () => {
    // setup shopper with denied consent
    const shopperId = await setupTestShopper(storeA, '+15005550012', 'denied');
    const sessionId = crypto.randomUUID();

    const messageLogId = await insertMessageLog(storeA, {
      store_id: storeA,
      shopper_id: shopperId,
      campaign_id: campaignAId,
      channel: 'whatsapp',
      provider: 'mock',
      provider_message_id: null,
      template_id: 'browse-recovery-whatsapp',
      status: 'pending',
      idempotency_key: `eligible:${campaignAId}:${shopperId}:${sessionId}:day1`,
      sent_at: null,
    });

    const actionPayload = {
      tenantId: storeA,
      sessionId,
      shopperId,
      campaignId: campaignAId,
      messageLogId,
      identity: { channel: 'whatsapp', encryptedValue: encryptPII('+15005550012') },
      templateId: 'browse-recovery-whatsapp',
    };

    await producer.send({
      topic: 'events.campaign.eligible',
      messages: [{ key: shopperId, value: JSON.stringify(actionPayload) }],
    });

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const finalLog = await withStoreContext(storeA, async (trx) => {
      return await trx('message_logs').where({ id: messageLogId }).first();
    });
    expect(finalLog.status).toBe('failed');
    expect(finalLog.failure_reason).toContain('consent');
  });

  it('K. Webhook verification GET challenge', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/v1/webhooks/whatsapp',
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'revynta_local_verify',
        'hub.challenge': 'challenge-accepted-123',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('challenge-accepted-123');
  });

  it('L & M. Webhook delivery status out-of-order mapper', async () => {
    const shopperId = await setupTestShopper(storeA, '+15005550015');
    const providerMsgId = `wamid.TestWebhook_${crypto.randomUUID()}`;

    const messageLogId = await insertMessageLog(storeA, {
      store_id: storeA,
      shopper_id: shopperId,
      campaign_id: campaignAId,
      channel: 'whatsapp',
      provider: 'mock',
      provider_message_id: providerMsgId,
      template_id: 'browse-recovery-whatsapp',
      status: 'sent', // Initially sent
      idempotency_key: `eligible:${campaignAId}:${shopperId}:${crypto.randomUUID()}:day1`,
      sent_at: new Date(),
    });

    // 1. Send 'delivered' status webhook
    const statusPayload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba_id',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '16505553333', phone_number_id: '109677328511' },
            statuses: [{
              id: providerMsgId,
              status: 'delivered',
              timestamp: Math.floor(Date.now() / 1000).toString(),
              recipient_id: '+15005550015',
            }],
          },
          field: 'messages',
        }],
      }],
    };

    const webhookResponse1 = await fastify.inject({
      method: 'POST',
      url: '/api/v1/webhooks/whatsapp',
      payload: statusPayload,
    });
    expect(webhookResponse1.statusCode).toBe(200);

    const logDelivered = await withStoreContext(storeA, async (trx) => {
      return await trx('message_logs').where({ id: messageLogId }).first();
    });
    expect(logDelivered.status).toBe('delivered');
    expect(logDelivered.delivered_at).toBeDefined();

    // 2. Send 'sent' status (out of order). Status should remain 'delivered' (guard against regression)
    const statusPayloadSent = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba_id',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '16505553333', phone_number_id: '109677328511' },
            statuses: [{
              id: providerMsgId,
              status: 'sent',
              timestamp: Math.floor(Date.now() / 1000).toString(),
              recipient_id: '+15005550015',
            }],
          },
          field: 'messages',
        }],
      }],
    };

    const webhookResponse2 = await fastify.inject({
      method: 'POST',
      url: '/api/v1/webhooks/whatsapp',
      payload: statusPayloadSent,
    });
    expect(webhookResponse2.statusCode).toBe(200);

    const logFinal = await withStoreContext(storeA, async (trx) => {
      return await trx('message_logs').where({ id: messageLogId }).first();
    });
    expect(logFinal.status).toBe('delivered'); // Guarded against state regression!
  });

  it('F & G. Inbound shopper reply and STOP opt-out flow', async () => {
    const testPhone = `+1500${Math.floor(1000000 + Math.random() * 9000000)}`;
    const shopperId = await setupTestShopper(storeA, testPhone);

    // Shopper replies with 'STOP' to opt out
    const inboundMessagePayload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba_id',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '16505553333', phone_number_id: '109677328511' },
            contacts: [{ profile: { name: 'K. Harberts' }, wa_id: testPhone }],
            messages: [{
              from: testPhone,
              id: 'wamid.ABGGFlCG5sJU_inbound_123',
              timestamp: Math.floor(Date.now() / 1000).toString(),
              text: { body: 'STOP' },
              type: 'text',
            }],
          },
          field: 'messages',
        }],
      }],
    };

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/webhooks/whatsapp',
      payload: inboundMessagePayload,
    });
    expect(response.statusCode).toBe(200);

    // Allow async DB write to settle
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify marketing consent has been revoked
    const consent = await withStoreContext(storeA, async (trx) => {
      return await trx('consent_records')
        .where({ store_id: storeA, shopper_id: shopperId, purpose: 'marketing' })
        .first();
    });
    expect(consent.status).toBe('denied');
    expect(consent.withdrawn_at).toBeDefined();

    // Verify audit log has been written
    const storeRow = await withStoreContext(storeA, async (trx) => {
      return await trx('stores').where({ id: storeA }).first();
    });
    
    // We bypass RLS to verify audit logging insertion
    const auditLog = await withAdminContext(async (adminTrx) => {
      return await adminTrx('audit_logs')
        .where({ organization_id: storeRow.organization_id, action: 'optout', resource_id: shopperId })
        .first();
    });
    expect(auditLog).toBeDefined();
  });

  it('N & O. Tenant/Store Isolation checks', async () => {
    // Querying Store B integration settings using Store B phone_number_id
    const shopperBId = await setupTestShopper(storeB, '+15005550030');
    const providerMsgId = `wamid.IsolationTest_${crypto.randomUUID()}`;

    const messageLogBId = await insertMessageLog(storeB, {
      store_id: storeB,
      shopper_id: shopperBId,
      campaign_id: campaignAId,
      channel: 'whatsapp',
      provider: 'mock',
      provider_message_id: providerMsgId,
      template_id: 'browse-recovery-whatsapp',
      status: 'sent',
      idempotency_key: `eligible:${campaignAId}:${shopperBId}:${crypto.randomUUID()}:day1`,
      sent_at: new Date(),
    });

    // Send webhook with Store B phone_number_id = '109677328522'
    const statusPayload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba_id',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '16505554444', phone_number_id: '109677328522' },
            statuses: [{
              id: providerMsgId,
              status: 'read',
              timestamp: Math.floor(Date.now() / 1000).toString(),
              recipient_id: '+15005550030',
            }],
          },
          field: 'messages',
        }],
      }],
    };

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/webhooks/whatsapp',
      payload: statusPayload,
    });
    expect(response.statusCode).toBe(200);

    // Verify Store B message log updated
    const logB = await withStoreContext(storeB, async (trx) => {
      return await trx('message_logs').where({ id: messageLogBId }).first();
    });
    expect(logB.status).toBe('read');

    // Tenant Isolation check: Verify Store A has no access or update to Store B log
    await expect(
      withStoreContext(storeA, async (trx) => {
        await trx.raw("SET ROLE revynta_app");
        return await trx('message_logs').where({ id: messageLogBId }).first();
      })
    ).resolves.toBeUndefined(); // Returns undefined due to RLS filter!
  });

  it('P. Webhook status transition matrix validations', async () => {
    const helperSendWebhook = async (providerMsgId: string, toStatus: string) => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'waba_id',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '16505553333', phone_number_id: '109677328511' },
              statuses: [{
                id: providerMsgId,
                status: toStatus,
                timestamp: Math.floor(Date.now() / 1000).toString(),
                recipient_id: '+15005559999',
              }],
            },
            field: 'messages',
          }],
        }],
      };
      await fastify.inject({ method: 'POST', url: '/api/v1/webhooks/whatsapp', payload });
    };

    const helperCreateLog = async (initialStatus: string): Promise<{ id: string, providerMsgId: string }> => {
      const shopperId = await setupTestShopper(storeA, `+1500${Math.floor(1000000 + Math.random() * 9000000)}`);
      const providerMsgId = `wamid.TransTest_${crypto.randomUUID()}`;
      const messageLogId = await insertMessageLog(storeA, {
        store_id: storeA,
        shopper_id: shopperId,
        campaign_id: campaignAId,
        channel: 'whatsapp',
        provider: 'mock',
        provider_message_id: providerMsgId,
        template_id: 'browse-recovery-whatsapp',
        status: initialStatus,
        idempotency_key: `eligible:${campaignAId}:${shopperId}:${crypto.randomUUID()}:day1`,
        sent_at: initialStatus === 'pending' ? null : new Date(),
      });
      return { id: messageLogId, providerMsgId };
    };

    const helperGetStatus = async (id: string): Promise<string> => {
      const row = await withStoreContext(storeA, async (trx) => {
        return await trx('message_logs').where({ id }).first();
      });
      return row.status;
    };

    // 1. sent -> delivered (Allowed)
    const log1 = await helperCreateLog('sent');
    await helperSendWebhook(log1.providerMsgId, 'delivered');
    expect(await helperGetStatus(log1.id)).toBe('delivered');

    // 2. delivered -> read (Allowed)
    const log2 = await helperCreateLog('delivered');
    await helperSendWebhook(log2.providerMsgId, 'read');
    expect(await helperGetStatus(log2.id)).toBe('read');

    // 3. sent -> read (Allowed)
    const log3 = await helperCreateLog('sent');
    await helperSendWebhook(log3.providerMsgId, 'read');
    expect(await helperGetStatus(log3.id)).toBe('read');

    // 4. delivered -> sent (Blocked)
    const log4 = await helperCreateLog('delivered');
    await helperSendWebhook(log4.providerMsgId, 'sent');
    expect(await helperGetStatus(log4.id)).toBe('delivered');

    // 5. read -> sent (Blocked)
    const log5 = await helperCreateLog('read');
    await helperSendWebhook(log5.providerMsgId, 'sent');
    expect(await helperGetStatus(log5.id)).toBe('read');

    // 6. delivered -> failed (Blocked)
    const log6 = await helperCreateLog('delivered');
    await helperSendWebhook(log6.providerMsgId, 'failed');
    expect(await helperGetStatus(log6.id)).toBe('delivered');

    // 7. read -> failed (Blocked)
    const log7 = await helperCreateLog('read');
    await helperSendWebhook(log7.providerMsgId, 'failed');
    expect(await helperGetStatus(log7.id)).toBe('read');

    // 8. failed -> delivered (Blocked)
    const log8 = await helperCreateLog('failed');
    await helperSendWebhook(log8.providerMsgId, 'delivered');
    expect(await helperGetStatus(log8.id)).toBe('failed');

    // 9. duplicate delivered (Blocked)
    const log9 = await helperCreateLog('delivered');
    await helperSendWebhook(log9.providerMsgId, 'delivered');
    expect(await helperGetStatus(log9.id)).toBe('delivered');

    // 10. duplicate failed (Blocked)
    const log10 = await helperCreateLog('failed');
    await helperSendWebhook(log10.providerMsgId, 'failed');
    expect(await helperGetStatus(log10.id)).toBe('failed');

    // 11. out-of-order webhook delivery
    const log11 = await helperCreateLog('sent');
    await helperSendWebhook(log11.providerMsgId, 'read');
    expect(await helperGetStatus(log11.id)).toBe('read');
    await helperSendWebhook(log11.providerMsgId, 'delivered');
    expect(await helperGetStatus(log11.id)).toBe('read');
  });
});
