import { kafka, producer, connectProducer } from '../kafka-client.js';
import {
  redis,
  withStoreContext,
  sessionKey,
  updateSessionState,
  recordAffinitySignal,
  isPurchaseSuppressed,
  checkDurablePurchaseSuppression,
  upsertShopperIntent,
  checkAndMarkEventDurable,
} from '@revynta/database';
import { logger } from '@revynta/observability';
import { EnrichedEvent } from '@revynta/shared-types';
import { sendToDLQ, isTransientError, retry } from '../dlq.js';
import { HeuristicIntentModel, SessionState, SignalContribution } from '@revynta/intent-engine';
import { scheduleInactivityCheck } from './inactivity-scheduler.js';

const consumer = kafka.consumer({ groupId: 'session-processor-group' });
const SESSION_TTL = 45 * 60; // 45 minutes

const intentModel = new HeuristicIntentModel();

export async function start(): Promise<void> {
  await consumer.connect();
  await connectProducer();
  await consumer.subscribe({ topic: 'events.enriched', fromBeginning: true });

  logger.info('Session State Consumer started.');

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const startTime = Date.now();
      let eventPayload = '';

      try {
        if (!message.value) return;

        eventPayload = message.value.toString();
        const event = JSON.parse(eventPayload) as EnrichedEvent;

        const {
          tenantId,
          sessionId,
          shopperId,
          eventType,
          eventTime,
          productId,
          productCategories,
          eventId,
        } = event;

        // 1. Idempotency check: Redis fast-path + PostgreSQL event_dedup fallback
        const isNew = await checkAndMarkEventDurable(tenantId, 'session-processor-group', eventId);
        if (!isNew) {
          logger.debug({ eventId }, 'Duplicate session event detected. Skipping processing.');
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

        await retry(async () => {
          const key = sessionKey(tenantId, sessionId);
          const eventTimestampMs = new Date(eventTime).getTime();

          // 3. Check purchase suppression (Redis + PostgreSQL fallback)
          let isSuppressed = await isPurchaseSuppressed(tenantId, shopperId);
          if (!isSuppressed) {
            isSuppressed = await checkDurablePurchaseSuppression(tenantId, shopperId);
          }

          // 4. Out-of-order check
          const lastTsRaw = await redis.hget(key, 'last_event_timestamp');
          const lastTs = lastTsRaw ? parseInt(lastTsRaw, 10) : 0;
          const isNewer = eventTimestampMs >= lastTs;

          // 5. Update Redis session counters & state
          const pipeline = redis.pipeline();

          if (isNewer) {
            pipeline.hset(key, {
              shopper_id: shopperId,
              store_id: tenantId,
              last_activity_at: eventTime,
              last_event_timestamp: eventTimestampMs.toString(),
            });
          }

          pipeline.hincrby(key, 'event_count', 1);

          if (eventType === 'page_view') {
            pipeline.hincrby(key, 'page_views', 1);
          } else if (eventType === 'product_view') {
            pipeline.hincrby(key, 'product_views', 1);
            if (productId) {
              pipeline.hset(key, `viewed_product:${productId}`, '1');
              pipeline.hset(key, 'last_product_id', productId);
              await recordAffinitySignal(tenantId, 'product', productId, 5);
            }
            if (productCategories && productCategories.length > 0) {
              pipeline.hset(key, 'last_categories', JSON.stringify(productCategories));
              for (const cat of productCategories) {
                await recordAffinitySignal(tenantId, 'category', cat, 3);
              }
            }
          } else if (eventType === 'cart_add') {
            pipeline.hincrby(key, 'cart_adds', 1);
            if (productId) {
              await recordAffinitySignal(tenantId, 'product', productId, 15);
            }
          } else if (eventType === 'checkout_init') {
            pipeline.hincrby(key, 'checkout_initiations', 1);
          }

          pipeline.expire(key, SESSION_TTL);
          await pipeline.exec();

          // 6. Calculate Intent Score & Top 5 Explanations using IntentEngine
          const currentHash = await redis.hgetall(key);
          const rawSignalsJSON = currentHash.signals_json;
          let signals: SignalContribution[] = rawSignalsJSON ? JSON.parse(rawSignalsJSON) : [];

          // Process current event signal
          const sessionState: SessionState = {
            tenantId,
            storeId: tenantId,
            sessionId,
            shopperId,
            lastActivityAt: currentHash.last_activity_at || eventTime,
            lastEventTimestamp: lastTs,
            eventCount: parseInt(currentHash.event_count || '1', 10),
            pageViews: parseInt(currentHash.page_views || '0', 10),
            productViews: parseInt(currentHash.product_views || '0', 10),
            cartAdds: parseInt(currentHash.cart_adds || '0', 10),
            checkoutInitiations: parseInt(currentHash.checkout_initiations || '0', 10),
            purchaseCompleted: isSuppressed || currentHash.purchase_completed === 'true',
            viewedProducts: {},
            viewedCategories: {},
            signals,
          };

          const eventSignal = intentModel.processEventSignal(sessionState, event);
          if (eventSignal) {
            signals.push(eventSignal);
            // Cap total stored signals in session to 50
            if (signals.length > 50) {
              signals = signals.slice(-50);
            }
          }

          sessionState.signals = signals;
          const intentResult = intentModel.calculateIntent(sessionState);

          // Write calculated intent back to Redis session hash
          await redis.hset(key, {
            signals_json: JSON.stringify(signals),
            intent_score: intentResult.score.toString(),
            intent_segment: intentResult.segment,
            intent_explanations: JSON.stringify(intentResult.explanations),
            model_version: intentResult.modelVersion,
          });

          // 7. Sync Session state & Intent state to PostgreSQL
          await withStoreContext(tenantId, async (trx) => {
            const sessionRow = await trx('sessions')
              .where({ session_token: sessionId })
              .first();

            if (sessionRow) {
              if (isNewer) {
                await trx('sessions')
                  .where({ id: sessionRow.id })
                  .update({
                    last_active_at: new Date(eventTime),
                    updated_at: new Date(),
                  });
              }
            } else {
              await trx('sessions').insert({
                store_id: tenantId,
                shopper_id: shopperId,
                session_token: sessionId,
                last_active_at: new Date(eventTime),
              });
            }
          });

          // Sync durable shopper intent score and explanations to Postgres
          await upsertShopperIntent(
            tenantId,
            shopperId,
            intentResult.score,
            intentResult.segment,
            intentResult.explanations,
            intentResult.modelVersion
          );

          // Schedule BullMQ inactivity delayed check
          await scheduleInactivityCheck(tenantId, sessionId, shopperId);
        }, 3, 500);

        logger.debug(
          {
            sessionId,
            eventType,
            tenantId,
            latencyMs: Date.now() - startTime,
          },
          'Session state & Intent processed successfully'
        );
      } catch (error) {
        logger.error({ err: error, payload: eventPayload }, 'Error processing session state');
        if (isTransientError(error as Error)) {
          throw error;
        }
        await sendToDLQ(message, {
          consumerName: 'session-processor-group',
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
  logger.info('Session State Consumer stopped.');
}
