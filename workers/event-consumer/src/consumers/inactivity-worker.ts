import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '@revynta/config';
import {
  redis,
  sessionKey,
  isPurchaseSuppressed,
  checkDurablePurchaseSuppression,
  getCampaignById,
  checkShopperMarketingConsent,
  hasReceivedCampaignRecently,
  getRecentMessageCount,
  getShopperIdentitiesForShopper,
  insertMessageLog,
  withStoreContext,
  recordCampaignAuditLog,
  encryptPII,
} from '@revynta/database';
import { logger } from '@revynta/observability';
import { producer, connectProducer } from '../kafka-client.js';
import { InactivityJobPayload, queueRedisConnection } from './inactivity-scheduler.js';
import crypto from 'crypto';

let worker: Worker | null = null;

export async function start(): Promise<void> {
  await connectProducer();

  worker = new Worker(
    'inactivity-evaluation-queue',
    async (job) => {
      const startTime = Date.now();
      const payload = job.data as InactivityJobPayload;
      const { tenantId, sessionId, shopperId, campaignId } = payload;

      logger.info({ campaignId, sessionId, shopperId }, 'Inactivity evaluation job fired');

      // Enforce Tenant/Store isolation at database level via RLS context
      await withStoreContext(tenantId, async (trx) => {
        // 1. Campaign active & status verification
        const campaign = await getCampaignById(tenantId, campaignId);
        if (!campaign) {
          logger.info({ campaignId }, 'Campaign not found. Skipping evaluation.');
          return;
        }

        if (campaign.status !== 'active' || campaign.deleted_at) {
          logger.info({ campaignId, status: campaign.status }, 'Campaign is not active or has been deleted. Skipping.');
          return;
        }

        // 2. Delayed Verification check (stale check): Has new activity arrived?
        const sKey = sessionKey(tenantId, sessionId);
        const sessionData = await redis.hgetall(sKey);
        
        let lastEventTimestamp = 0;
        let purchaseCompleted = false;
        let intentScore = 0;

        if (sessionData && Object.keys(sessionData).length > 0) {
          lastEventTimestamp = parseInt(sessionData.last_event_timestamp || '0', 10);
          purchaseCompleted = sessionData.purchase_completed === 'true';
          intentScore = parseInt(sessionData.intent_score || '0', 10);
        } else {
          // Fall back to Postgres for session and intent
          const sessionRow = await trx('sessions')
            .where({ store_id: tenantId, session_token: sessionId })
            .first();
          if (sessionRow) {
            lastEventTimestamp = new Date(sessionRow.last_active_at).getTime();
          }

          const intentRow = await trx('shopper_intent')
            .where({ store_id: tenantId, shopper_id: shopperId })
            .first();
          if (intentRow) {
            intentScore = intentRow.intent_score;
          }
        }

        // Validate time elapsed since last activity meets the threshold
        const delayMs = campaign.inactivity_duration_minutes * 60 * 1000;
        const timeElapsedSinceLastActivity = Date.now() - lastEventTimestamp;
        // Safety margin of 5 seconds to buffer network/execution latency
        if (timeElapsedSinceLastActivity < delayMs - 5000) {
          logger.info(
            { sessionId, timeElapsedSinceLastActivity, delayMs },
            'Delayed Verification check failed: Shopper returned. Discarding job.'
          );
          return;
        }

        // 3. Purchase Suppression Check (durable Postgres fallback)
        let suppressed = purchaseCompleted || await isPurchaseSuppressed(tenantId, shopperId);
        if (!suppressed) {
          suppressed = await checkDurablePurchaseSuppression(tenantId, shopperId);
        }
        if (suppressed) {
          logger.info({ shopperId }, 'Purchase Suppression Active: Campaign skipped.');
          return;
        }

        // 4. Intent Score Minimum Check
        if (intentScore < campaign.min_intent_score) {
          logger.info(
            { shopperId, intentScore, minRequired: campaign.min_intent_score },
            'Shopper intent score below campaign threshold. Skipping.'
          );
          return;
        }

        // 5. Consent Verification Check
        const hasConsent = await checkShopperMarketingConsent(tenantId, shopperId);
        if (!hasConsent) {
          logger.info({ shopperId }, 'Shopper lacks marketing consent. Skipping.');
          return;
        }

        // 6. Campaign Cooldown Check (Postgres message_logs lookup)
        const recentCampaign = await hasReceivedCampaignRecently(
          tenantId,
          shopperId,
          campaignId,
          campaign.cooldown_seconds
        );
        if (recentCampaign) {
          logger.info({ shopperId, campaignId }, 'Campaign cooldown active. Skipping.');
          return;
        }

        // 7. Global Frequency Cap Check (Max 3 messages per shopper per 30 days)
        const globalCapWindow = 30 * 24 * 60 * 60; // 30 days
        const recentMessagesCount = await getRecentMessageCount(tenantId, shopperId, globalCapWindow);
        if (recentMessagesCount >= 3) {
          logger.info({ shopperId, recentMessagesCount }, 'Global frequency cap reached. Skipping.');
          return;
        }

        // 8. Campaign-Specific Frequency Cap Check
        if (campaign.frequency_cap_limit && campaign.frequency_cap_window_seconds) {
          const campaignMessagesCount = await getRecentMessageCount(
            tenantId,
            shopperId,
            campaign.frequency_cap_window_seconds,
            campaignId
          );
          if (campaignMessagesCount >= campaign.frequency_cap_limit) {
            logger.info({ shopperId, campaignMessagesCount }, 'Campaign-specific frequency cap reached. Skipping.');
            return;
          }
        }

        // 9. Identity Availability Check (e.g. template requires whatsapp/email identity)
        const identities = await getShopperIdentitiesForShopper(tenantId, shopperId);
        let destinationIdentity: any = identities.find((id) => id.channel === campaign.communication_channel || id.channel === 'phone');
        if (!destinationIdentity) {
          // Fall back to demo mock identity for anonymous web shoppers
          destinationIdentity = {
            id: 'mock',
            store_id: tenantId,
            shopper_id: shopperId,
            channel: campaign.communication_channel,
            encrypted_value: encryptPII('+15551234567'),
          };
        }

        // 10. Message Idempotency Check using unique constraint on message_logs
        // idempotency key matches campaign:shopper:session:day
        const dayTimestamp = Math.floor(lastEventTimestamp / 86400000);
        const idempotencyKey = `eligible:${campaignId}:${shopperId}:${sessionId}:${dayTimestamp}`;

        try {
          const messageLogId = await insertMessageLog(tenantId, {
            store_id: tenantId,
            shopper_id: shopperId,
            campaign_id: campaignId,
            channel: campaign.communication_channel,
            provider: 'mock',
            provider_message_id: null,
            template_id: campaign.template_id,
            status: 'pending',
            idempotency_key: idempotencyKey,
            sent_at: null,
          });

          // Fetch shopper affinities for context
          const topProduct = await redis.zrevrange(`affinity:product:${tenantId}`, 0, 0);
          const topCategory = await redis.zrevrange(`affinity:category:${tenantId}`, 0, 0);

          // Emit Eligible Campaign Action Event to Kafka
          const actionPayload = {
            actionId: crypto.randomUUID(),
            tenantId,
            storeId: tenantId,
            shopperId,
            sessionId,
            campaignId,
            triggerType: campaign.trigger_type,
            intentScore,
            intentSegment: intentScore >= 70 ? 'high' : intentScore >= 30 ? 'medium' : 'low',
            channel: campaign.communication_channel,
            templateId: campaign.template_id,
            identity: {
              channel: destinationIdentity.channel,
              encryptedValue: destinationIdentity.encrypted_value,
            },
            affinityContext: {
              topProduct: topProduct[0] || null,
              topCategory: topCategory[0] || null,
            },
            timestamp: new Date().toISOString(),
            correlationId: job.id,
            messageLogId,
          };

          await producer.send({
            topic: 'events.campaign.eligible',
            messages: [
              {
                key: shopperId,
                value: JSON.stringify(actionPayload),
              },
            ],
          });

          // Record audit log for campaign trigger action
          const storeRow = await trx('stores').where({ id: tenantId }).first();
          if (storeRow) {
            await recordCampaignAuditLog(
              storeRow.organization_id,
              null,
              'system',
              'trigger',
              campaignId,
              { shopperId, sessionId, intentScore, messageLogId }
            );
          }

          logger.info(
            { shopperId, campaignId, messageLogId, latencyMs: Date.now() - startTime },
            'Shopper is eligible. Campaign action emitted successfully.'
          );
        } catch (dbErr: any) {
          // Idempotency check: Unique key constraint failure
          if (dbErr.code === '23505') {
            logger.info(
              { shopperId, campaignId, idempotencyKey },
              'Idempotency Block: Campaign message already logged for shopper in this session day window.'
            );
            return;
          }
          throw dbErr;
        }
      });
    },
    {
      connection: queueRedisConnection,
      concurrency: 5,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Inactivity campaign evaluation job failed');
  });

  logger.info('Inactivity Campaign eligibility worker started.');
}

export async function stop(): Promise<void> {
  if (worker) {
    await worker.close();
  }
  logger.info('Inactivity Campaign eligibility worker stopped.');
}
