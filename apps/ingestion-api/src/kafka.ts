import { Kafka, Producer } from 'kafkajs';
import { config } from '@revynta/config';
import { logger } from '@revynta/observability';
import { TrackingEvent } from '@revynta/shared-types';

const kafka = new Kafka({
  clientId: 'ingestion-api',
  brokers: config.kafka.brokers,
  retry: {
    initialRetryTime: 100,
    retries: 5,
  },
});

let producer: Producer | null = null;

export async function connectKafka(): Promise<void> {
  try {
    producer = kafka.producer();
    await producer.connect();
    logger.info('Kafka Ingestion Producer connected successfully.');
  } catch (error) {
    logger.error(error as Error, 'Failed to connect Ingestion Producer to Kafka');
    throw error;
  }
}

export async function disconnectKafka(): Promise<void> {
  if (producer) {
    await producer.disconnect();
    logger.info('Kafka Ingestion Producer disconnected.');
  }
}

export async function produceRawEvents(tenantId: string, events: TrackingEvent[]): Promise<void> {
  if (!producer) {
    throw new Error('Kafka producer is not connected');
  }

  // Key by visitorId to preserve strict session order within partitions
  const messages = events.map((event) => ({
    key: event.visitorId,
    value: JSON.stringify({
      ...event,
      tenantId, // Inject validated tenant ID into the raw payload
    }),
  }));

  await producer.send({
    topic: 'events.raw',
    messages,
  });
}

export async function checkKafkaHealth(): Promise<boolean> {
  try {
    if (!producer) return false;
    const admin = kafka.admin();
    await admin.connect();
    await admin.listTopics();
    await admin.disconnect();
    return true;
  } catch {
    return false;
  }
}
