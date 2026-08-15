import { logger } from '@revynta/observability';

const consumerType = process.env.CONSUMER_TYPE;

if (!consumerType) {
  logger.error('Missing CONSUMER_TYPE environment variable. Exiting.');
  process.exit(1);
}

let startFn: () => Promise<void>;
let stopFn: () => Promise<void>;

switch (consumerType) {
  case 'raw-enricher':
    ({ start: startFn, stop: stopFn } = await import('./consumers/raw-enricher.js'));
    break;
  case 'analytics-writer':
    ({ start: startFn, stop: stopFn } = await import('./consumers/analytics-writer.js'));
    break;
  case 'session-processor':
    ({ start: startFn, stop: stopFn } = await import('./consumers/session-processor.js'));
    break;
  case 'identity-resolver':
    ({ start: startFn, stop: stopFn } = await import('./consumers/identity-resolver.js'));
    break;
  case 'purchase-handler':
    ({ start: startFn, stop: stopFn } = await import('./consumers/purchase-handler.js'));
    break;
  case 'intent-scorer':
    ({ start: startFn, stop: stopFn } = await import('./consumers/intent-scorer.js'));
    break;
  case 'inactivity-worker':
    ({ start: startFn, stop: stopFn } = await import('./consumers/inactivity-worker.js'));
    break;
  case 'whatsapp-dispatcher':
    ({ start: startFn, stop: stopFn } = await import('./consumers/whatsapp-dispatcher.js'));
    break;
  default:
    logger.error(`Unknown consumer type: '${consumerType}'. Exiting.`);
    process.exit(1);
}

// Graceful shutdown handling
let isStopping = false;
async function shutdown(signal: string) {
  if (isStopping) return;
  isStopping = true;
  
  logger.info(`Received ${signal}. Shutting down consumer gracefully...`);
  
  try {
    if (stopFn) {
      await stopFn();
    }
    logger.info('Graceful shutdown completed successfully.');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  logger.info(`Bootstrapping consumer of type: '${consumerType}'`);
  await startFn();
} catch (err) {
  logger.error({ err }, `Fatal error running consumer '${consumerType}'`);
  process.exit(1);
}
