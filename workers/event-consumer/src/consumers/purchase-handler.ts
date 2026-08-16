import { kafka, producer, connectProducer } from '../kafka-client.js';
import {
  redis,
  withStoreContext,
  sessionKey,
  setPurchaseSuppression,
  recordPurchaseSuppression,
  upsertShopperIntent,
  checkAndMarkEventDurable,
} from '@revynta/database';
import { logger } from '@revynta/observability';
import { EnrichedEvent } from '@revynta/shared-types';
import { sendToDLQ, isTransientError } from '../dlq.js';

const consumer = kafka.consumer({ groupId: 'purchase-handler-group' });
const DEDUPLICATION_TTL = 86400; // 24 hours suppression window

export async function start(): Promise<void> {
  await consumer.connect();
  await connectProducer();
  await consumer.subscribe({ topic: 'events.enriched', fromBeginning: true });

  logger.info('Purchase Handler Consumer started.');

  consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const startTime = Date.now();
      let eventPayload = '';

      try {
        if (!message.value) return;

        eventPayload = message.value.toString();
        const event = JSON.parse(eventPayload) as EnrichedEvent;

        if (event.eventType !== 'purchase') {
          return;
        }

        const { tenantId, sessionId, shopperId, eventTime, eventId } = event;

        // 1. Idempotency check: Redis fast-path + PostgreSQL event_dedup fallback
        const isNew = await checkAndMarkEventDurable(tenantId, 'purchase-handler-group', eventId);
        if (!isNew) {
          logger.debug({ eventId }, 'Duplicate purchase event detected. Skipping processing.');
          return;
        }

        // 2. Tenant isolation check: verify shopper belongs to store
        const shopperExists = await withStoreContext(tenantId, async (trx) => {
          const shopper = await trx('shoppers')
            .where({ id: shopperId, store_id: tenantId })
            .first();
          return !!shopper;
        });
        if (!shopperExists) {
          logger.warn(
            { shopperId, tenantId },
            'Security Alert: Shopper does not belong to the claimed tenant. Skipping event.'
          );
          return;
        }

        logger.info(
          { shopperId, tenantId, sessionId },
          'Intercepted shopper purchase event. Triggering Purchase Suppression Circuit Breaker...'
        );

        // 3. Establish Purchase Suppression in Redis & PostgreSQL
        const sKey = sessionKey(tenantId, sessionId);

        await setPurchaseSuppression(tenantId, shopperId, DEDUPLICATION_TTL);

        // Update session state hash in Redis to terminal converted state
        await redis.hset(sKey, {
          purchase_completed: 'true',
          converted_at: eventTime,
          intent_score: '0',
          intent_segment: 'low',
        });

        // 4. Write durable purchase suppression record to PostgreSQL
        await recordPurchaseSuppression(tenantId, shopperId, 24, 'v1');

        // Reset durable shopper intent score in PostgreSQL
        await upsertShopperIntent(tenantId, shopperId, 0, 'low', [], 'v1');

        // 5. Record conversion audit log in PostgreSQL
        await withStoreContext(tenantId, async (trx) => {
          const store = await trx('stores').where({ id: tenantId }).first();
          await trx('audit_logs').insert({
            organization_id: store.organization_id,
            action: 'shopper_purchase_conversion',
            resource: 'shopper',
            resource_id: shopperId,
            actor_type: 'shopper',
            actor_id: null,
            metadata: {
              session_token: sessionId,
              event_time: eventTime,
              message: 'Shopper conversion completed. Intent recovery suppressed.',
            },
          });
        });

        logger.debug(
          {
            shopperId,
            tenantId,
            latencyMs: Date.now() - startTime,
          },
          'Purchase conversion registered, intent reset, and suppression locked'
        );
      } catch (error) {
        logger.error({ err: error, payload: eventPayload }, 'Error processing purchase event');
        if (isTransientError(error as Error)) {
          throw error;
        }
        await sendToDLQ(message, {
          consumerName: 'purchase-handler-group',
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
  logger.info('Purchase Handler Consumer stopped.');
}
