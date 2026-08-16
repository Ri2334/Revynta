import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { config } from '@revynta/config';
import { logger } from '@revynta/observability';
import { routes } from './routes.js';

const fastify = Fastify({
  logger: logger as any,
});

async function bootstrap() {
  await fastify.register(cors, {
    origin: (origin, cb) => {
      cb(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-store-id', 'x-store-api-key', 'Accept'],
  });

  await fastify.register(cookie, {
    secret: config.security.jwtSecret,
  });

  await fastify.register(routes);

  if (process.env.NODE_ENV !== 'test') {
    try {
      const address = await fastify.listen({
        port: config.merchantApi.port,
        host: config.merchantApi.host,
      });
      logger.info(`Merchant Core API Server listening on ${address}`);
    } catch (error) {
      logger.error(error as Error, 'Failed to start Merchant API server');
      process.exit(1);
    }
  }
}

const gracefulShutdown = async () => {
  logger.info('Initiating graceful shutdown of Merchant API Service...');
  try {
    await fastify.close();
    logger.info('HTTP Server stopped.');
    process.exit(0);
  } catch (error) {
    logger.error(error as Error, 'Error during graceful shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

bootstrap();
export { fastify }; // Expose for integration testing
