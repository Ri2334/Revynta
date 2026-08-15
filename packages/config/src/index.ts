import dotenv from 'dotenv';
import path from 'path';

// Load .env from workspace root if running from a subdirectory
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

export const config = {
  env: process.env.NODE_ENV || 'development',
  
  ingestion: {
    port: parseInt(process.env.INGESTION_PORT || '3000', 10),
    host: process.env.INGESTION_HOST || '0.0.0.0',
  },
  
  merchantApi: {
    port: parseInt(process.env.MERCHANT_API_PORT || '3001', 10),
    host: process.env.MERCHANT_API_HOST || '0.0.0.0',
  },
  
  postgres: {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'postgres',
    database: process.env.PG_DATABASE || 'revynta_dev',
  },
  
  clickhouse: {
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    user: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || 'dev_clickhouse_pass',
    database: process.env.CLICKHOUSE_DATABASE || 'revynta_analytics',
  },
  
  redis: {
    uri: process.env.REDIS_URI || 'redis://localhost:6379',
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
  
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  },
  
  security: {
    piiEncryptionKey: process.env.PII_ENCRYPTION_KEY || 'dev_key_must_be_32_bytes_long_12',
    jwtSecret: process.env.JWT_SECRET || 'revynta_secret_jwt_key_for_development',
  },
  
  whatsapp: {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || 'mock-phone-id',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || 'mock-access-token',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'revynta_local_verify',
    appSecret: process.env.WHATSAPP_APP_SECRET || 'mock-app-secret',
  }
};
