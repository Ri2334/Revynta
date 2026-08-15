import { kafka, producer, connectProducer } from '../kafka-client.js';
import { insertAnalyticsEvents } from '@revynta/database';
import { logger } from '@revynta/observability';
import { EnrichedEvent } from '@revynta/shared-types';
import { sendToDLQ, isTransientError } from '../dlq.js';

const consumer = kafka.consumer({ groupId: 'clickhouse-writer-group' });

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;

/**
 * Inserts events with exponential backoff retry logic
 */
async function insertWithRetry(events: EnrichedEvent[]): Promise<void> {
  let attempt = 0;
  
  while (attempt < MAX_RETRIES) {
    try {
      await insertAnalyticsEvents(events);
      return; // Success!
    } catch (error) {
      attempt++;
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      logger.warn({ err: error, attempt, backoffMs: backoff }, 'ClickHouse batch insert failed. Retrying...');
      
      if (attempt >= MAX_RETRIES) {
        throw error;
      }
      
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

export async function start(): Promise<void> {
  await consumer.connect();
  await connectProducer();
  await consumer.subscribe({ topic: 'events.enriched', fromBeginning: true });

  logger.info('ClickHouse Analytics Writer Consumer started.');

  await consumer.run({
    eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
      const startTime = Date.now();
      const events: EnrichedEvent[] = [];

      for (const message of batch.messages) {
        if (!isRunning() || isStale()) break;

        if (message.value) {
          try {
            const event = JSON.parse(message.value.toString()) as EnrichedEvent;
            events.push(event);
          } catch (err) {
            logger.warn({ value: message.value.toString() }, 'Skipping invalid JSON event in ClickHouse writer');
            resolveOffset(message.offset);
          }
        }
      }

      if (events.length === 0) {
        return;
      }

      try {
        // Send heartbeat before writing to avoid triggering partition re-balances during large writes
        await heartbeat();
        
        await insertWithRetry(events);
        
        // Resolve offsets for all messages in the batch
        const lastMessage = batch.messages[batch.messages.length - 1];
        resolveOffset(lastMessage.offset);

        logger.debug({
          batchSize: events.length,
          latencyMs: Date.now() - startTime,
        }, 'Successfully committed batch write to ClickHouse');

      } catch (error) {
        logger.error({ err: error, batchSize: events.length }, 'Failed ClickHouse insert after retries');
        if (isTransientError(error as Error)) {
          throw error;
        }
        for (const message of batch.messages) {
          if (message.value) {
            await sendToDLQ(message, {
              consumerName: 'clickhouse-writer-group',
              originalTopic: batch.topic,
              partition: batch.partition,
              offset: message.offset,
              error: error as Error,
            });
          }
        }
        
        // Resolve offset to avoid blocking partition indefinitely (at least we logged/sent to DLQ)
        const lastMessage = batch.messages[batch.messages.length - 1];
        resolveOffset(lastMessage.offset);
      }
    },
  });
}

export async function stop(): Promise<void> {
  await consumer.disconnect();
  logger.info('ClickHouse Analytics Writer Consumer stopped.');
}
