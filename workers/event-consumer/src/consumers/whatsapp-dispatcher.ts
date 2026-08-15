import { kafka, connectProducer } from '../kafka-client.js';
import {
  redis,
  withStoreContext,
  isPurchaseSuppressed,
  checkDurablePurchaseSuppression,
  getCampaignById,
  checkShopperMarketingConsent,
  hasReceivedCampaignRecently,
  getRecentMessageCount,
  getShopperIdentitiesForShopper,
  decryptPII,
  insertMessageLog,
} from '@revynta/database';
import { logger } from '@revynta/observability';
import { sendToDLQ, isTransientError, retry } from '../dlq.js';
import { getWhatsAppProvider } from './whatsapp-provider/factory.js';

const consumer = kafka.consumer({ groupId: 'whatsapp-dispatcher-group' });

export async function start(): Promise<void> {
  await consumer.connect();
  await connectProducer();
  await consumer.subscribe({ topic: 'events.campaign.eligible', fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const startTime = Date.now();
      const eventPayload = message.value?.toString();
      if (!eventPayload) return;

      let event: any;
      try {
        event = JSON.parse(eventPayload);
      } catch (err) {
        logger.error({ err, payload: eventPayload }, 'Malformed campaign eligible event. Sending to DLQ.');
        await sendToDLQ(message, {
          consumerName: 'whatsapp-dispatcher-group',
          originalTopic: topic,
          partition,
          offset: message.offset,
          error: err as Error,
        });
        return;
      }

      const { tenantId, sessionId, shopperId, campaignId, messageLogId, identity, templateId, affinityContext } = event;

      try {
        await retry(async () => {
          await withStoreContext(tenantId, async (trx) => {
            // 1. Idempotency & Message state lookup
            const msgLog = await trx('message_logs')
              .where({ store_id: tenantId, id: messageLogId })
              .first();

            if (!msgLog) {
              logger.warn({ messageLogId }, 'Associated message log not found. Skipping send.');
              return;
            }

            if (msgLog.status !== 'pending') {
              logger.info({ messageLogId, status: msgLog.status }, 'Message already processed. Idempotency block.');
              return;
            }

            // 2. Final Safety Checks
            // A. Campaign status check
            const campaign = await getCampaignById(tenantId, campaignId);
            if (!campaign || campaign.status !== 'active' || campaign.deleted_at) {
              await trx('message_logs')
                .where({ id: messageLogId })
                .update({ status: 'failed', failure_reason: 'Campaign became inactive or was deleted' });
              return;
            }

            // B. Store status check
            const storeRow = await trx('stores').where({ id: tenantId }).first();
            if (!storeRow) {
              await trx('message_logs')
                .where({ id: messageLogId })
                .update({ status: 'failed', failure_reason: 'Store not found' });
              return;
            }

            // C. Consent Verification
            const hasConsent = await checkShopperMarketingConsent(tenantId, shopperId);
            if (!hasConsent) {
              await trx('message_logs')
                .where({ id: messageLogId })
                .update({ status: 'failed', failure_reason: 'Shopper marketing consent withdrawn' });
              return;
            }

            // D. Purchase Suppression (circuit breaker)
            let isSuppressed = await isPurchaseSuppressed(tenantId, shopperId);
            if (!isSuppressed) {
              isSuppressed = await checkDurablePurchaseSuppression(tenantId, shopperId);
            }
            if (isSuppressed) {
              await trx('message_logs')
                .where({ id: messageLogId })
                .update({ status: 'failed', failure_reason: 'Purchase suppression circuit breaker active' });
              return;
            }

            // E. Campaign Cooldown double check (excluding current log ID)
            const recentMessage = await trx('message_logs')
              .where({ store_id: tenantId, shopper_id: shopperId, campaign_id: campaignId })
              .andWhere('id', '!=', messageLogId)
              .andWhere('created_at', '>=', new Date(Date.now() - campaign.cooldown_seconds * 1000))
              .andWhere('status', '!=', 'failed')
              .first();

            if (recentMessage) {
              await trx('message_logs')
                .where({ id: messageLogId })
                .update({ status: 'failed', failure_reason: 'Campaign cooldown violated' });
              return;
            }

            // F. Global frequency cap check (excluding current log ID)
            const globalMessagesCountRow = await trx('message_logs')
              .where({ store_id: tenantId, shopper_id: shopperId })
              .andWhere('id', '!=', messageLogId)
              .andWhere('created_at', '>=', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
              .andWhere('status', '!=', 'failed')
              .count('id as count')
              .first();

            const globalMessagesCount = globalMessagesCountRow ? parseInt(globalMessagesCountRow.count as string, 10) : 0;
            if (globalMessagesCount >= 3) {
              await trx('message_logs')
                .where({ id: messageLogId })
                .update({ status: 'failed', failure_reason: 'Global frequency cap reached' });
              return;
            }

            // G. Resolve WhatsApp Integration & Decrypt credentials
            const integration = await trx('integrations')
              .where({ store_id: tenantId, provider: 'whatsapp', status: 'active' })
              .first();

            if (!integration) {
              await trx('message_logs')
                .where({ id: messageLogId })
                .update({ status: 'failed', failure_reason: 'Active WhatsApp integration not configured' });
              return;
            }

            const { phoneNumberId, accessTokenEncrypted } = integration.configuration;
            if (!phoneNumberId || !accessTokenEncrypted) {
              await trx('message_logs')
                .where({ id: messageLogId })
                .update({ status: 'failed', failure_reason: 'WhatsApp integration credentials incomplete' });
              return;
            }

            let decryptedAccessToken = '';
            try {
              decryptedAccessToken = decryptPII(accessTokenEncrypted);
            } catch (err) {
              logger.error(err as Error, 'Failed to decrypt WhatsApp integration access token');
              await trx('message_logs')
                .where({ id: messageLogId })
                .update({ status: 'failed', failure_reason: 'Failed to decrypt credentials' });
              return;
            }

            // H. Shopper identity / destination check
            const shopperIdentities = await getShopperIdentitiesForShopper(tenantId, shopperId);
            const channelIdentity = shopperIdentities.find((id) => id.channel === campaign.communication_channel);
            if (!channelIdentity) {
              await trx('message_logs')
                .where({ id: messageLogId })
                .update({ status: 'failed', failure_reason: 'Shopper lacks destination identity details' });
              return;
            }

            let decryptedPhone = '';
            try {
              decryptedPhone = decryptPII(channelIdentity.encrypted_value);
            } catch (err) {
              logger.error(err as Error, 'Failed to decrypt shopper phone identity');
              await trx('message_logs')
                .where({ id: messageLogId })
                .update({ status: 'failed', failure_reason: 'Failed to decrypt identity contact details' });
              return;
            }

            // 3. Invoke Messaging Provider
            const isMock = integration.configuration.isMock === true || decryptedAccessToken.startsWith('mock-');
            const provider = getWhatsAppProvider(phoneNumberId, decryptedAccessToken, {
              isMock,
              simulatedLatencyMs: integration.configuration.simulatedLatencyMs,
              simulatedErrorStatus: integration.configuration.simulatedErrorStatus,
            });

            // Normalize template body parameters:
            // Placeholder 1: Product Name or category
            // Placeholder 2: Discount template code or simple message
            const bodyParams = [
              { type: 'text' as const, text: affinityContext?.topProduct || 'items in your cart' },
              { type: 'text' as const, text: affinityContext?.topCategory || 'browsed items' },
            ];

            try {
              const result = await provider.sendTemplateMessage({
                recipientPhoneNumber: decryptedPhone,
                templateName: campaign.template_id,
                languageCode: 'en',
                parameters: bodyParams,
              });

              // 4. Update status to sent on success
              await trx('message_logs')
                .where({ id: messageLogId })
                .update({
                  status: 'sent',
                  provider_message_id: result.providerMessageId,
                  sent_at: new Date(),
                  updated_at: new Date(),
                });

              logger.info(
                { messageLogId, providerMessageId: result.providerMessageId, latencyMs: Date.now() - startTime },
                'WhatsApp message dispatched and logged successfully'
              );
            } catch (providerErr: any) {
              if (providerErr.isTransient) {
                logger.warn(
                  { err: providerErr, messageLogId },
                  'Transient WhatsApp provider error. Triggering retry.'
                );
                throw providerErr; // Propagates to event-consumer retry loop
              }

              // Permanent provider failure: update status to failed
              logger.error(
                { err: providerErr, messageLogId },
                'Permanent WhatsApp provider error. Discarding job.'
              );
              await trx('message_logs')
                .where({ id: messageLogId })
                .update({
                  status: 'failed',
                  failure_reason: providerErr.message || 'Meta API rejected request',
                  updated_at: new Date(),
                });
            }
          });
        }, 3, 2000);
      } catch (error: any) {
        logger.error({ err: error, payload: eventPayload }, 'Error dispatching WhatsApp campaign message');
        if (isTransientError(error)) {
          throw error; // Let consumer loop handle offset retry
        }
        await sendToDLQ(message, {
          consumerName: 'whatsapp-dispatcher-group',
          originalTopic: topic,
          partition,
          offset: message.offset,
          error: error as Error,
        });
      }
    },
  });
}

export async function stop(): Promise<void> {
  await consumer.disconnect();
  logger.info('WhatsApp Dispatcher Consumer stopped.');
}
