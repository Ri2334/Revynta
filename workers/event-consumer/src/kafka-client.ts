import { Kafka } from 'kafkajs';
import { config } from '@revynta/config';

export const kafka = new Kafka({
  clientId: 'event-consumers',
  brokers: config.kafka.brokers,
  retry: {
    initialRetryTime: 100,
    retries: 5,
  },
});

export const producer = kafka.producer();

let isProducerConnected = false;

export async function connectProducer(): Promise<void> {
  if (!isProducerConnected) {
    await producer.connect();
    isProducerConnected = true;
  }
}

export async function disconnectProducer(): Promise<void> {
  if (isProducerConnected) {
    await producer.disconnect();
    isProducerConnected = false;
  }
}
