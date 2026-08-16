import { kafka, producer, connectProducer } from '../kafka-client.js';
import { redis, withStoreContext, encryptPII, hashIdentifier } from '@revynta/database';
import { logger } from '@revynta/observability';
import { sendToDLQ, isTransientError } from '../dlq.js';

const consumer = kafka.consumer({ groupId: 'identity-resolver-group' });

export async function start(): Promise<void> {
  await consumer.connect();
  await connectProducer();
  await consumer.subscribe({ topic: 'events.identity', fromBeginning: true });

  logger.info('Identity Resolver Consumer started.');

  consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const startTime = Date.now();
      let eventPayload = '';

      try {
        if (!message.value) return;

        eventPayload = message.value.toString();
        const event = JSON.parse(eventPayload);

        const { tenantId, shopperId, metadata, eventId } = event;

        // Idempotency check: block duplicate processing
        const idempotencyKey = `processed_event:identity-resolver-group:${eventId}`;
        const isNew = await redis.set(idempotencyKey, '1', 'EX', 300, 'NX');
        if (!isNew) {
          logger.debug({ eventId }, 'Duplicate identity event detected. Skipping processing.');
          return;
        }
        if (!tenantId || !shopperId || !metadata) {
          throw new Error('Malformed identity event payload: Missing tenantId, shopperId, or metadata');
        }

        const email = metadata.email?.toString().trim();
        const phone = metadata.phone?.toString().trim();

        // Ensure shopper exists for store
        await withStoreContext(tenantId, async (trx) => {
          const shopper = await trx('shoppers')
            .where({ id: shopperId, store_id: tenantId })
            .first();
          if (!shopper) {
            await trx('shoppers').insert({
              id: shopperId,
              store_id: tenantId,
              first_seen_at: new Date(),
              last_seen_at: new Date(),
              intent_score: 0,
              intent_segment: 'low',
            }).onConflict(['id', 'store_id']).ignore();
          }
        });

        if (!email && !phone) {
          logger.warn({ shopperId, tenantId }, 'Identity event has no email or phone. Skipping.');
          return;
        }

        await withStoreContext(tenantId, async (trx) => {
          // 1. Resolve email identity
          if (email) {
            const emailHash = hashIdentifier(email);
            const encryptedEmail = encryptPII(email);

            const existing = await trx('shopper_identities')
              .where({ store_id: tenantId, channel: 'email', identifier_hash: emailHash })
              .first();

            if (!existing) {
              await trx('shopper_identities').insert({
                store_id: tenantId,
                shopper_id: shopperId,
                channel: 'email',
                identifier_hash: emailHash,
                encrypted_value: encryptedEmail,
              });
              logger.info({ shopperId, tenantId }, 'Registered new email shopper identity');
            } else if (existing.shopper_id !== shopperId) {
              logger.warn({
                existingShopperId: existing.shopper_id,
                newShopperId: shopperId,
                tenantId,
              }, 'Email identity conflict: Email already bound to another shopper. Triggering merge logs.');
              
              // Record profile merge log in audit trail or update map
              await trx('audit_logs').insert({
                organization_id: (await trx('stores').where({ id: tenantId }).first()).organization_id,
                action: 'shopper_identity_conflict',
                resource: 'shopper',
                resource_id: shopperId,
                actor_type: 'system',
                actor_id: null,
                metadata: {
                  message: 'Deterministic email identifier bound to a different shopper profile',
                  existing_shopper_id: existing.shopper_id,
                  new_shopper_id: shopperId,
                  identifier_hash: emailHash,
                },
              });
            }
          }

          // 2. Resolve phone identity
          if (phone) {
            const phoneHash = hashIdentifier(phone);
            const encryptedPhone = encryptPII(phone);

            const existing = await trx('shopper_identities')
              .where({ store_id: tenantId, channel: 'phone', identifier_hash: phoneHash })
              .first();

            if (!existing) {
              await trx('shopper_identities').insert({
                store_id: tenantId,
                shopper_id: shopperId,
                channel: 'phone',
                identifier_hash: phoneHash,
                encrypted_value: encryptedPhone,
              });
              logger.info({ shopperId, tenantId }, 'Registered new phone shopper identity');
            } else if (existing.shopper_id !== shopperId) {
              logger.warn({
                existingShopperId: existing.shopper_id,
                newShopperId: shopperId,
                tenantId,
              }, 'Phone identity conflict: Phone number already bound to another shopper.');
            }
          }
        });

        logger.debug({
          shopperId,
          tenantId,
          latencyMs: Date.now() - startTime,
        }, 'Identity resolved and processed');

      } catch (error) {
        logger.error({ err: error, payload: eventPayload }, 'Error processing identity resolution');
        if (isTransientError(error as Error)) {
          throw error;
        }
        await sendToDLQ(message, {
          consumerName: 'identity-resolver-group',
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
  logger.info('Identity Resolver Consumer stopped.');
}
