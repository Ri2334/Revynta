import { kafka, producer, connectProducer } from '../kafka-client.js';
import { redis, withStoreContext } from '@revynta/database';
import { logger } from '@revynta/observability';
import { EnrichedEvent } from '@revynta/shared-types';
import { sendToDLQ, isTransientError, retry } from '../dlq.js';

interface TrackingEvent {
  eventId: string;
  sessionId: string;
  visitorId: string;
  eventType: any;
  timestamp: number;
  pageUrl: string;
  referrer?: string;
  metadata?: any;
}

const consumer = kafka.consumer({ groupId: 'ingestion-enricher-group' });

/**
 * Resolves shopper_id from visitorId. Checks Redis session mappings first,
 * falling back to PostgreSQL insert under correct store context if missing.
 */
async function resolveShopperId(tenantId: string, visitorId: string): Promise<string> {
  const cacheKey = `visitor_shopper_map:${visitorId}`;
  
  // 1. Try Redis cache
  const cachedShopperId = await redis.get(cacheKey);
  if (cachedShopperId) {
    return cachedShopperId;
  }

  // 2. Database check / creation under store context (RLS compliant)
  const shopperId = await withStoreContext(tenantId, async (trx) => {
    // Check if session token/visitorId mapping exists in sessions
    const existingSession = await trx('sessions')
      .where({ session_token: visitorId })
      .first();

    if (existingSession) {
      return existingSession.shopper_id;
    }

    // Create a new Shopper profile
    const [newShopper] = await trx('shoppers')
      .insert({ store_id: tenantId })
      .returning('id');

    // Create session mapping record
    await trx('sessions').insert({
      store_id: tenantId,
      shopper_id: newShopper.id,
      session_token: visitorId,
    });

    return newShopper.id;
  });

  // 3. Cache in Redis (30 days TTL)
  await redis.set(cacheKey, shopperId, 'EX', 86400 * 30);
  return shopperId;
}

export async function start(): Promise<void> {
  await consumer.connect();
  await connectProducer();
  await consumer.subscribe({ topic: 'events.raw', fromBeginning: true });

  logger.info('Raw Event Enrichment Consumer started.');

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const startTime = Date.now();
      let rawData: any = null;

      try {
        if (!message.value) {
          throw new Error('Message value is empty');
        }

        rawData = JSON.parse(message.value.toString());
        const tenantId = rawData.tenantId;
        
        if (!tenantId) {
          throw new Error('Missing tenantId in event payload');
        }

        // Validate basic event structure
        const { eventId, sessionId, visitorId, eventType, timestamp, pageUrl, referrer, metadata } = rawData as TrackingEvent;
        if (!eventId || !sessionId || !visitorId || !eventType || !timestamp) {
          throw new Error('Missing required tracking fields in payload');
        }

        // Idempotency check: block duplicate processing
        const idempotencyKey = `processed_event:ingestion-enricher-group:${eventId}`;
        const isNew = await redis.set(idempotencyKey, '1', 'EX', 300, 'NX');
        if (!isNew) {
          logger.debug({ eventId }, 'Duplicate raw event detected. Skipping processing.');
          return;
        }

        // Wrap database & routing stubs in retry helper
        await retry(async () => {
          // 1. Resolve shopper_id
          const shopperId = await resolveShopperId(tenantId, visitorId);

          // 2. Parse basic Client metadata (IP, User-Agent)
          const ip = metadata?.ip || '';
          const userAgent = metadata?.userAgent || '';
          
          // Mock simple country extraction for testing
          const country = ip === '127.0.0.1' || ip === '::1' ? 'Local' : 'Unknown';

          // 3. Format Enriched Event Envelope
          const enrichedEvent: EnrichedEvent = {
            eventTime: new Date(timestamp).toISOString(),
            eventId,
            tenantId,
            sessionId,
            shopperId,
            eventType,
            sdkVersion: rawData.sdkVersion || '1.0.0',
            pageUrl,
            referrer,
            userAgent,
            ipAddress: ip,
            country,
            productId: rawData.productId || rawData.metadata?.productId || undefined,
            productPrice: rawData.productPrice || rawData.metadata?.productPrice || undefined,
            productCategories: rawData.productCategories || rawData.metadata?.productCategories || undefined,
            productName: rawData.productName || rawData.metadata?.productName || undefined,
            query: rawData.query || rawData.metadata?.query || undefined,
            metadata: rawData.metadata || {},
          };

          // 4. Route events based on type
          const routingPromises: Promise<any>[] = [];

          // Always publish to main enriched events stream
          routingPromises.push(
            producer.send({
              topic: 'events.enriched',
              messages: [{ key: shopperId, value: JSON.stringify(enrichedEvent) }],
            })
          );

          // Special routing stubs
          if (eventType === 'consent_change') {
            routingPromises.push(
              producer.send({
                topic: 'events.consent',
                messages: [{ key: shopperId, value: message.value }],
              })
            );
          } else if (eventType === 'identify') {
            routingPromises.push(
              producer.send({
                topic: 'events.identity',
                messages: [{ key: shopperId, value: message.value }],
              })
            );
          }

          await Promise.all(routingPromises);
        }, 3, 500);

        logger.debug({
          eventId,
          eventType,
          tenantId,
          latencyMs: Date.now() - startTime,
        }, 'Event enriched and routed successfully');

      } catch (error) {
        if (isTransientError(error as Error)) {
          throw error;
        }
        await sendToDLQ(message, {
          consumerName: 'ingestion-enricher-group',
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
  logger.info('Raw Event Enrichment Consumer stopped.');
}
