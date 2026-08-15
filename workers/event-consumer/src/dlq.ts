import { producer } from './kafka-client.js';
import { logger } from '@revynta/observability';

export interface DLQContext {
  consumerName: string;
  originalTopic: string;
  partition: number;
  offset: string;
  error: Error;
  retryCount?: number;
}

/**
 * Normalizes and sends failed telemetry events to the 'events.deadletter' topic.
 */
export async function sendToDLQ(
  rawMessage: { key: any; value: any },
  ctx: DLQContext
): Promise<void> {
  const originalPayloadStr = rawMessage.value ? rawMessage.value.toString() : null;
  let originalEvent: any = null;
  
  try {
    if (originalPayloadStr) {
      originalEvent = JSON.parse(originalPayloadStr);
    }
  } catch (err) {
    // Keep it as raw string if JSON parsing fails
    originalEvent = originalPayloadStr;
  }

  const dlqPayload = {
    originalEvent,
    eventId: originalEvent?.eventId || null,
    eventType: originalEvent?.eventType || null,
    tenantId: originalEvent?.tenantId || null,
    originalTopic: ctx.originalTopic,
    partition: ctx.partition,
    offset: ctx.offset,
    failureReason: ctx.error.message,
    errorType: ctx.error.name || 'Error',
    timestamp: new Date().toISOString(),
    consumer: ctx.consumerName,
    retryCount: ctx.retryCount || 0,
    stack: ctx.error.stack || null,
  };

  try {
    await producer.send({
      topic: 'events.deadletter',
      messages: [
        {
          key: rawMessage.key ? rawMessage.key.toString() : null,
          value: JSON.stringify(dlqPayload),
        },
      ],
    });

    logger.warn(
      {
        consumer: ctx.consumerName,
        eventId: dlqPayload.eventId,
        originalTopic: ctx.originalTopic,
        partition: ctx.partition,
        offset: ctx.offset,
        error: ctx.error.message,
      },
      'Event failed processing and was successfully routed to the DLQ'
    );
  } catch (dlqError) {
    logger.error(
      {
        err: dlqError,
        consumer: ctx.consumerName,
        originalPayload: originalPayloadStr,
        error: ctx.error.message,
      },
      'CRITICAL: Failed to write event to the dead-letter queue (DLQ)'
    );
  }
}

/**
 * Checks if the error is a transient database or connectivity failure.
 */
export function isTransientError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('connection') ||
    msg.includes('timeout') ||
    msg.includes('exhausted') ||
    msg.includes('econnrefused') ||
    msg.includes('unavailable') ||
    msg.includes('deadlock') ||
    msg.includes('closed') ||
    msg.includes('socket')
  );
}

/**
 * Standard retry helper for transient operations.
 */
export async function retry<T>(fn: () => Promise<T>, retries = 3, delay = 500): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= retries || !isTransientError(err as Error)) {
        throw err;
      }
      logger.warn({ attempt, error: (err as Error).message }, 'Transient error encountered. Retrying...');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
