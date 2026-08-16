import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyRawBody from 'fastify-raw-body';
import { config } from '@revynta/config';
import { logger } from '@revynta/observability';
import { routes } from './routes.js';
import { connectKafka, disconnectKafka } from './kafka.js';
import { disconnectRedis } from './auth.js';

const fastify = Fastify({
  // Use shared pino logger
  logger: logger as any,
});

async function bootstrap() {
  // CORS configuration allowing cross-origin tracking requests from any merchant website domain
  await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: '*',
    credentials: false,
  });

  // Enable raw body parsing for Webhook signature verification
  await fastify.register(fastifyRawBody, {
    field: 'rawBody',
    global: true,
    encoding: 'utf8',
    runFirst: true,
  });

  // Global rate limiter to protect the ingestion API
  await fastify.register(rateLimit, {
    max: 1000,
    timeWindow: '1 minute',
  });

  // Register endpoints
  await fastify.register(routes);

  // Connect to Redpanda
  try {
    await connectKafka();
  } catch (error) {
    logger.error(error as Error, 'Failed to connect to broker during startup');
    process.exit(1);
  }

  if (process.env.NODE_ENV !== 'test') {
    try {
      const address = await fastify.listen({
        port: config.ingestion.port,
        host: config.ingestion.host,
      });
      logger.info(`Ingestion API Server listening on ${address}`);
    } catch (error) {
      logger.error(error as Error, 'Failed to start HTTP server');
      process.exit(1);
    }
  }
}

const gracefulShutdown = async () => {
  logger.info('Initiating graceful shutdown of Ingestion Service...');
  
  try {
    await fastify.close();
    logger.info('HTTP Server stopped accepting new connections.');
    
    await disconnectKafka();
    await disconnectRedis();
    logger.info('Redpanda and Redis sessions closed.');
    
    process.exit(0);
  } catch (error) {
    logger.error(error as Error, 'Error encountered during graceful shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

bootstrap();
export { fastify }; // For integration testing
