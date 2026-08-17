import { kafka, producer, connectProducer } from '../kafka-client.js';
import {
  redis,
  withStoreContext,
  sessionKey,
  isPurchaseSuppressed,
  checkDurablePurchaseSuppression,
  upsertShopperIntent,
  checkAndMarkEventDurable,
} from '@revynta/database';
import { logger } from '@revynta/observability';
import { EnrichedEvent } from '@revynta/shared-types';
import { HeuristicIntentModel, SessionState } from '@revynta/intent-engine';
import { sendToDLQ, isTransientError } from '../dlq.js';

const consumer = kafka.consumer({ groupId: 'intent-scorer-group' });
const intentModel = new HeuristicIntentModel();

export async function start(): Promise<void> {
  await consumer.connect();
  await connectProducer();
  await consumer.subscribe({ topic: 'events.enriched', fromBeginning: true });

  logger.info('Intent Scorer Consumer started.');

  consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const startTime = Date.now();
      let eventPayload = '';

      try {
        if (!message.value) return;

        eventPayload = message.value.toString();
        const event = JSON.parse(eventPayload) as EnrichedEvent;
        const { tenantId, sessionId, shopperId, eventId } = event;

        // Idempotency check: Redis fast-path + PostgreSQL event_dedup fallback
        const isNew = await checkAndMarkEventDurable(tenantId, 'intent-scorer-group', eventId);
        if (!isNew) {
          logger.debug({ eventId }, 'Duplicate intent event detected. Skipping processing.');
          return;
        }

        // Tenant isolation: ensure shopper belongs to store context
        await withStoreContext(tenantId, async (trx) => {
          await trx('shoppers').insert({
            id: shopperId,
            store_id: tenantId,
            created_at: new Date(),
            updated_at: new Date(),
            intent_score: 0,
            intent_segment: 'low',
          }).onConflict('id').merge({ store_id: tenantId, updated_at: new Date() });
        });

        const sKey = sessionKey(tenantId, sessionId);

        // Check purchase suppression circuit breaker
        let isSuppressed = await isPurchaseSuppressed(tenantId, shopperId);
        if (!isSuppressed) {
          isSuppressed = await checkDurablePurchaseSuppression(tenantId, shopperId);
        }

        const sessionData = await redis.hgetall(sKey);
        const signalsRaw = sessionData.signals_json;
        const signals = signalsRaw ? JSON.parse(signalsRaw) : [];

        const sessionState: SessionState = {
          tenantId,
          storeId: tenantId,
          sessionId,
          shopperId,
          lastActivityAt: sessionData.last_activity_at || event.eventTime,
          lastEventTimestamp: parseInt(sessionData.last_event_timestamp || '0', 10),
          eventCount: parseInt(sessionData.event_count || '1', 10),
          pageViews: parseInt(sessionData.page_views || '0', 10),
          productViews: parseInt(sessionData.product_views || '0', 10),
          cartAdds: parseInt(sessionData.cart_adds || '0', 10),
          checkoutInitiations: parseInt(sessionData.checkout_initiations || '0', 10),
          purchaseCompleted: isSuppressed || sessionData.purchase_completed === 'true',
          viewedProducts: {},
          viewedCategories: {},
          signals,
        };

        const result = intentModel.calculateIntent(sessionState, event);

        // Store intent evaluation result in Redis & Postgres
        await redis.hset(sKey, {
          intent_score: result.score.toString(),
          intent_segment: result.segment,
          intent_explanations: JSON.stringify(result.explanations),
          model_version: result.modelVersion,
        });

        await upsertShopperIntent(
          tenantId,
          shopperId,
          result.score,
          result.segment,
          result.explanations,
          result.modelVersion
        );

        // Publish intent calculation event for downstreams (e.g. analytics or real-time triggers)
        await producer.send({
          topic: 'events.intent',
          messages: [
            {
              key: shopperId,
              value: JSON.stringify({
                tenantId,
                sessionId,
                shopperId,
                score: result.score,
                segment: result.segment,
                explanations: result.explanations,
                modelVersion: result.modelVersion,
                timestamp: new Date().toISOString(),
              }),
            },
          ],
        });

        logger.debug(
          {
            shopperId,
            sessionId,
            score: result.score,
            segment: result.segment,
            latencyMs: Date.now() - startTime,
          },
          'Intent score calculated and dispatched'
        );
      } catch (error) {
        logger.error({ err: error, payload: eventPayload }, 'Error scoring shopper intent');
        if (isTransientError(error as Error)) {
          throw error;
        }
        await sendToDLQ(message, {
          consumerName: 'intent-scorer-group',
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
  logger.info('Intent Scorer Consumer stopped.');
}
