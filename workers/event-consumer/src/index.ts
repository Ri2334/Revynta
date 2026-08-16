import { logger } from '@revynta/observability';

const ALL_CONSUMER_TYPES = [
  'raw-enricher',
  'analytics-writer',
  'session-processor',
  'identity-resolver',
  'purchase-handler',
  'intent-scorer',
  'inactivity-worker',
  'whatsapp-dispatcher',
];

const targetTypes = !process.env.CONSUMER_TYPE || process.env.CONSUMER_TYPE === 'all'
  ? ALL_CONSUMER_TYPES
  : [process.env.CONSUMER_TYPE];

const stopFns: (() => Promise<void>)[] = [];

for (const type of targetTypes) {
  try {
    let module: { start: () => Promise<void>; stop: () => Promise<void> };
    switch (type) {
      case 'raw-enricher':
        module = await import('./consumers/raw-enricher.js');
        break;
      case 'analytics-writer':
        module = await import('./consumers/analytics-writer.js');
        break;
      case 'session-processor':
        module = await import('./consumers/session-processor.js');
        break;
      case 'identity-resolver':
        module = await import('./consumers/identity-resolver.js');
        break;
      case 'purchase-handler':
        module = await import('./consumers/purchase-handler.js');
        break;
      case 'intent-scorer':
        module = await import('./consumers/intent-scorer.js');
        break;
      case 'inactivity-worker':
        module = await import('./consumers/inactivity-worker.js');
        break;
      case 'whatsapp-dispatcher':
        module = await import('./consumers/whatsapp-dispatcher.js');
        break;
      default:
        logger.error(`Unknown consumer type: '${type}'. Exiting.`);
        process.exit(1);
    }
    stopFns.push(module.stop);
    logger.info(`Bootstrapping consumer of type: '${type}'`);
    module.start().catch((err) => {
      logger.error({ err }, `Fatal error in consumer '${type}'`);
    });
  } catch (err) {
    logger.error({ err }, `Fatal error initializing consumer '${type}'`);
  }
}

// Graceful shutdown handling
let isStopping = false;
async function shutdown(signal: string) {
  if (isStopping) return;
  isStopping = true;
  
  logger.info(`Received ${signal}. Shutting down consumers gracefully...`);
  
  try {
    for (const stopFn of stopFns) {
      if (stopFn) await stopFn();
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
