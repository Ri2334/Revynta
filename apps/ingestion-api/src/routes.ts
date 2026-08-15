import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { validateApiKey } from './auth.js';
import { produceRawEvents } from './kafka.js';
import { IngressEventBatch } from '@revynta/shared-types';
import crypto from 'crypto';
import { config } from '@revynta/config';
import {
  withStoreContext,
  withAdminContext,
  hashIdentifier,
  recordCampaignAuditLog,
} from '@revynta/database';

export async function routes(fastify: FastifyInstance, options: FastifyPluginOptions): Promise<void> {
  
  // GET /health/liveness - Liveness check for container orchestration
  fastify.get('/health/liveness', async () => {
    return { status: 'healthy', process: 'alive', timestamp: Date.now() };
  });

  // GET /health/readiness - Readiness check with 2s timeout for DB, Redis, Kafka
  fastify.get('/health/readiness', async (request, reply) => {
    try {
      const { checkPostgresHealth, checkRedisHealth } = await import('@revynta/database');
      const { checkKafkaHealth } = await import('./kafka.js');

      const pgOk = await checkPostgresHealth().catch(() => false);
      const redisOk = await checkRedisHealth().catch(() => false);
      const kafkaOk = await checkKafkaHealth().catch(() => false);

      const isReady = pgOk && redisOk && kafkaOk;
      const status = isReady ? 200 : 503;

      return reply.status(status).send({
        status: isReady ? 'ready' : 'unready',
        dependencies: { postgres: pgOk, redis: redisOk, kafka: kafkaOk },
        timestamp: Date.now(),
      });
    } catch (err) {
      return reply.status(503).send({ status: 'unready', error: (err as Error).message });
    }
  });

  // GET /metrics - Prometheus metrics export
  fastify.get('/metrics', async (request, reply) => {
    const { getMetrics, getMetricsContentType } = await import('@revynta/observability');
    reply.header('Content-Type', getMetricsContentType());
    return reply.send(getMetrics());
  });

  const ingestSchema = {
    body: {
      type: 'object',
      properties: {
        storeKey: { type: 'string' },
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              eventId: { type: 'string', format: 'uuid' },
              sessionId: { type: 'string', format: 'uuid' },
              visitorId: { type: 'string', format: 'uuid' },
              eventType: { type: 'string' },
              timestamp: { type: 'integer' },
              pageUrl: { type: 'string' },
              referrer: { type: 'string' },
              metadata: { type: 'object' },
            },
            required: ['eventId', 'sessionId', 'visitorId', 'eventType', 'timestamp'],
          },
        },
      },
      required: ['storeKey', 'events'],
    },
  };

  fastify.post<{ Body: IngressEventBatch }>(
    '/api/v1/events',
    { schema: ingestSchema },
    async (request, reply) => {
      const { storeKey, events } = request.body;

      // Extract Key from custom header or body fallback
      const apiKey = (request.headers['x-store-api-key'] as string) || storeKey;

      if (!apiKey) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Missing API Key' });
      }

      // Authenticate key and fetch associated Tenant ID
      const tenantId = await validateApiKey(apiKey);
      if (!tenantId) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid API Key' });
      }

      // Enrich payload with network details
      const clientIp = request.ip;
      const userAgent = request.headers['user-agent'] || '';

      const enrichedEvents = events.map((event) => ({
        ...event,
        metadata: {
          ...event.metadata,
          ip: clientIp,
          userAgent,
        },
      }));

      // Asynchronously publish events to Kafka topic
      try {
        await produceRawEvents(tenantId, enrichedEvents);
      } catch (error) {
        fastify.log.error(error as Error, 'Failed to publish events to Kafka');
        return reply.status(503).send({ error: 'Service Unavailable', message: 'Failed to write to queue' });
      }

      // Return 202 Accepted
      return reply.status(202).send({ status: 'accepted', batchSize: events.length });
    }
  );

  // GET /api/v1/webhooks/whatsapp - Challenge verification for Meta setup
  fastify.get('/api/v1/webhooks/whatsapp', async (request, reply) => {
    const mode = (request.query as any)['hub.mode'];
    const token = (request.query as any)['hub.verify_token'];
    const challenge = (request.query as any)['hub.challenge'];

    const verifyToken = config.whatsapp.verifyToken || 'revynta_local_verify';

    if (mode === 'subscribe' && token === verifyToken) {
      fastify.log.info('WhatsApp webhook verified successfully');
      return reply.status(200).send(challenge);
    }
    fastify.log.warn({ token }, 'WhatsApp webhook verification failed');
    return reply.status(403).send({ error: 'Forbidden', message: 'Invalid verify token' });
  });

  // POST /api/v1/webhooks/whatsapp - Delivery status and shopper replies callbacks
  fastify.post('/api/v1/webhooks/whatsapp', async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'] as string;
    const appSecret = (config.whatsapp as any).appSecret;

    // Secure webhook verification if secret is configured in environment
    if (appSecret && !appSecret.startsWith('mock-')) {
      if (!signature) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Missing x-hub-signature-256 header' });
      }
      const rawBody = (request as any).rawBody || '';
      const hmac = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
      const expectedSignature = `sha256=${hmac}`;
      if (signature !== expectedSignature) {
        fastify.log.warn({ signature, expectedSignature }, 'Invalid webhook signature');
        return reply.status(401).send({ error: 'Unauthorized', message: 'Signature verification failed' });
      }
    }

    const payload = request.body as any;
    if (!payload || payload.object !== 'whatsapp_business_account') {
      return reply.status(200).send({ status: 'ignored' });
    }

    try {
      const entry = payload.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      if (!value) return reply.status(200).send({ status: 'ignored' });

      const metadata = value.metadata;
      const phoneNumberId = metadata?.phone_number_id;
      if (!phoneNumberId) return reply.status(200).send({ status: 'ignored' });

      // Resolve Tenant Store ID by querying the integrations table bypassing RLS context temporarily
      const integration = await withAdminContext(async (adminTrx: any) => {
        return await adminTrx('integrations')
          .whereRaw("configuration->>'phoneNumberId' = ?", [phoneNumberId])
          .first();
      });

      if (!integration) {
        fastify.log.warn({ phoneNumberId }, 'WhatsApp integration not found for phone number ID');
        return reply.status(200).send({ status: 'ignored' });
      }

      const storeId = integration.store_id;

      // Handle delivery status update
      if (value.statuses && value.statuses.length > 0) {
        const status = value.statuses[0];
        
        await withStoreContext(storeId, async (storeTrx: any) => {
          const log = await storeTrx('message_logs')
            .where({ provider_message_id: status.id })
            .first();

          if (log) {
            // State transition validation matrix to prevent out-of-order/stale webhook regressions
            const validTransitions: Record<string, string[]> = {
              pending: ['sent', 'delivered', 'read', 'failed'],
              sent: ['delivered', 'read', 'failed'],
              delivered: ['read'],
              read: [],
              failed: [],
            };

            const isTransitionAllowed = validTransitions[log.status]?.includes(status.status);

            if (isTransitionAllowed) {
              const updates: any = {
                status: status.status,
                updated_at: new Date(),
              };

              if (status.status === 'sent') updates.sent_at = new Date(parseInt(status.timestamp, 10) * 1000);
              if (status.status === 'delivered') updates.delivered_at = new Date(parseInt(status.timestamp, 10) * 1000);
              if (status.status === 'read') updates.read_at = new Date(parseInt(status.timestamp, 10) * 1000);
              if (status.status === 'failed') {
                updates.failed_at = new Date(parseInt(status.timestamp, 10) * 1000);
                updates.failure_reason = status.errors?.[0]?.title || 'Meta delivery failure';
              }

              await storeTrx('message_logs')
                .where({ id: log.id })
                .update(updates);

              fastify.log.info({ messageLogId: log.id, status: status.status }, 'Updated WhatsApp message delivery status');
            } else {
              fastify.log.info(
                { messageLogId: log.id, currentStatus: log.status, ignoredStatus: status.status },
                'Ignored out-of-order/stale message status update'
              );
            }
          }
        });
      }

      // Handle inbound replies and opt-outs
      if (value.messages && value.messages.length > 0) {
        const message = value.messages[0];
        const messageText = message.text?.body?.trim();

        if (messageText) {
          const isOptOut = ['STOP', 'UNSUBSCRIBE', 'CANCEL'].includes(messageText.toUpperCase());
          if (isOptOut) {
            const waId = message.from;
            const phoneHash = hashIdentifier(waId);

            await withStoreContext(storeId, async (storeTrx: any) => {
              const identityRow = await storeTrx('shopper_identities')
                .where({ store_id: storeId, channel: 'whatsapp', identifier_hash: phoneHash })
                .first();

              fastify.log.info({ phoneHash, identityRow }, 'Opt-out lookup identity row');

              if (identityRow) {
                const shopperId = identityRow.shopper_id;

                const consentRow = await storeTrx('consent_records')
                  .where({ store_id: storeId, shopper_id: shopperId, purpose: 'marketing' })
                  .first();

                fastify.log.info({ shopperId, consentRow }, 'Opt-out lookup consent row');

                if (consentRow) {
                  await storeTrx('consent_records')
                    .where({ id: consentRow.id })
                    .update({
                      status: 'denied',
                      withdrawn_at: new Date(),
                      updated_at: new Date(),
                    });
                } else {
                  await storeTrx('consent_records').insert({
                    store_id: storeId,
                    shopper_id: shopperId,
                    purpose: 'marketing',
                    status: 'denied',
                    source: 'whatsapp_optout',
                    policy_version: 'v1',
                    withdrawn_at: new Date(),
                  });
                }

                const storeRow = await storeTrx('stores').where({ id: storeId }).first();
                if (storeRow) {
                  await recordCampaignAuditLog(
                    storeRow.organization_id,
                    null,
                    'system',
                    'optout',
                    shopperId,
                    { waId }
                  );
                }

                fastify.log.info({ shopperId, waId }, 'Shopper opted out via WhatsApp. Marketing consent revoked.');
              }
            });
          }
        }
      }

      return reply.status(200).send({ status: 'processed' });
    } catch (err) {
      fastify.log.error(err as Error, 'Failed to process WhatsApp webhook payload');
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Failed to process payload' });
    }
  });
}
