import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import knex from 'knex';
import {
  postgres,
  withAdminContext,
  checkPostgresHealth,
  disconnectPostgres,
} from '../dist/postgres.js';
import {
  getClickHouseClient,
  initClickHouseSchema,
  insertAnalyticsEvents,
  checkClickHouseHealth,
} from '../dist/clickhouse.js';
import { checkRedisHealth, disconnectRedis } from '../dist/redis.js';
import { encryptPII, decryptPII, hashIdentifier } from '../dist/index.js';
import { EnrichedEvent } from '@revynta/shared-types';

describe('Database Integration Tests', () => {
  let appDb: any; // Restricted role connection for RLS checks

  // Helper context wrapper for restricted appDb
  async function withStoreContextApp<T>(
    storeId: string,
    callback: (trx: any) => Promise<T>
  ): Promise<T> {
    return appDb.transaction(async (trx: any) => {
      await trx.raw("SELECT set_config('app.current_store_id', ?, true)", [storeId]);
      return callback(trx);
    });
  }

  beforeAll(async () => {
    // 1. Verify healthcheck pings succeed
    const pgHealthy = await checkPostgresHealth();
    const redisHealthy = await checkRedisHealth();
    const chHealthy = await checkClickHouseHealth();

    expect(pgHealthy).toBe(true);
    expect(redisHealthy).toBe(true);
    expect(chHealthy).toBe(true);

    // 2. Run initial migrations to construct database
    // We execute rollback first to ensure we start from a clean slate
    await postgres.migrate.rollback(undefined, true);
    await postgres.migrate.latest();

    // 3. Boot ClickHouse schemas and truncate tables for clean test run
    await initClickHouseSchema();
    const chClient = getClickHouseClient();
    await chClient.exec({ query: 'TRUNCATE TABLE events_analytics' });
    await chClient.exec({ query: 'TRUNCATE TABLE daily_analytics_aggregates' });

    // 4. Initialize restricted app connection
    const pgConfig = postgres.client.connectionSettings;
    appDb = knex({
      client: 'pg',
      connection: {
        host: pgConfig.host,
        port: pgConfig.port,
        user: 'revynta_app',
        password: 'revynta_app_pass',
        database: pgConfig.database,
      },
    });
  });

  afterAll(async () => {
    // Close restricted role connection
    if (appDb) {
      await appDb.destroy();
    }

    // Rollback changes to clean up database state
    await postgres.migrate.rollback(undefined, true);

    // Close connections
    await disconnectPostgres();
    await disconnectRedis();
    const chClient = getClickHouseClient();
    await chClient.close();
  });

  describe('PostgreSQL RLS & Multi-Tenancy', () => {
    let orgAId: string;
    let orgBId: string;
    let storeAId: string;
    let storeBId: string;
    let shopperAId: string;
    let shopperBId: string;

    beforeAll(async () => {
      // Create Tenant configurations in Admin context (bypass RLS)
      await withAdminContext(async (trx) => {
        const [orgA] = await trx('organizations').insert({ name: 'Tenant Organization A' }).returning('*');
        const [orgB] = await trx('organizations').insert({ name: 'Tenant Organization B' }).returning('*');
        orgAId = orgA.id;
        orgBId = orgB.id;

        const [storeA] = await trx('stores').insert({ organization_id: orgAId, name: 'Store A', domain: 'storea.com' }).returning('*');
        const [storeB] = await trx('stores').insert({ organization_id: orgBId, name: 'Store B', domain: 'storeb.com' }).returning('*');
        storeAId = storeA.id;
        storeBId = storeB.id;
      });
    });

    it('should prevent cross-tenant writes and isolate read/write access via RLS', async () => {
      // 1. Create Shopper A under Store A context (using restricted app connection)
      await withStoreContextApp(storeAId, async (trx) => {
        const [shopperA] = await trx('shoppers').insert({ store_id: storeAId }).returning('*');
        shopperAId = shopperA.id;
      });

      // 2. Create Shopper B under Store B context (using restricted app connection)
      await withStoreContextApp(storeBId, async (trx) => {
        const [shopperB] = await trx('shoppers').insert({ store_id: storeBId }).returning('*');
        shopperBId = shopperB.id;
      });

      // 3. Query Store A shoppers: should only see Shopper A
      await withStoreContextApp(storeAId, async (trx) => {
        const shoppers = await trx('shoppers').select('*');
        expect(shoppers.length).toBe(1);
        expect(shoppers[0].id).toBe(shopperAId);
      });

      // 4. Query Store B shoppers: should only see Shopper B
      await withStoreContextApp(storeBId, async (trx) => {
        const shoppers = await trx('shoppers').select('*');
        expect(shoppers.length).toBe(1);
        expect(shoppers[0].id).toBe(shopperBId);
      });

      // 5. Query without RLS context: should find 0 shoppers on restricted app connection
      const appQueryCount = await appDb('shoppers').select('*');
      expect(appQueryCount.length).toBe(0);

      // 6. Query under Admin context (using admin superuser connection): should bypass RLS
      await withAdminContext(async (trx) => {
        const shoppers = await trx('shoppers').select('*');
        expect(shoppers.length).toBe(2);
      });
    });

    it('should block updates and deletes from cross-tenant context', async () => {
      // Try to delete Shopper B (Store B) while acting in Store A context
      await withStoreContextApp(storeAId, async (trx) => {
        const deletedRows = await trx('shoppers').where({ id: shopperBId }).delete();
        expect(deletedRows).toBe(0); // RLS hides the row, making it look like it does not exist
      });

      // Verify Shopper B is still alive in Admin view
      await withAdminContext(async (trx) => {
        const shopper = await trx('shoppers').where({ id: shopperBId }).first();
        expect(shopper).toBeDefined();
      });

      // Try to update Shopper B while acting in Store A context
      await withStoreContextApp(storeAId, async (trx) => {
        const updatedRows = await trx('shoppers').where({ id: shopperBId }).update({ updated_at: new Date() });
        expect(updatedRows).toBe(0);
      });
    });
  });

  describe('API Keys Security & Hashes', () => {
    it('should hash and resolve API keys securely', async () => {
      let storeId: string;
      const rawKey = 'rev_live_abcd1234efgh5678';
      const keyPrefix = 'rev_live';
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

      await withAdminContext(async (trx) => {
        const [org] = await trx('organizations').insert({ name: 'API Key Org' }).returning('*');
        const [store] = await trx('stores').insert({ organization_id: org.id, name: 'API Key Store', domain: 'apikey.com' }).returning('*');
        storeId = store.id;

        await trx('api_keys').insert({
          store_id: storeId,
          key_prefix: keyPrefix,
          key_hash: keyHash,
          name: 'Default Ingestion Key',
          status: 'active',
        });
      });

      // Fetch the Key under Store context on restricted appDb connection
      await withStoreContextApp(storeId, async (trx) => {
        const keyRecord = await trx('api_keys').where({ key_hash: keyHash }).first();
        expect(keyRecord).toBeDefined();
        expect(keyRecord.key_prefix).toBe(keyPrefix);
        expect(keyRecord.status).toBe('active');
      });
    });
  });

  describe('Message Log Idempotency Gates', () => {
    it('should block duplicates using unique idempotency constraints', async () => {
      let storeId: string;
      let shopperId: string;
      const idempotencyKey = 'campaign_xyz:shopper_abc:session_123:2026-08-15';

      await withAdminContext(async (trx) => {
        const [org] = await trx('organizations').insert({ name: 'Idempotency Org' }).returning('*');
        const [store] = await trx('stores').insert({ organization_id: org.id, name: 'Idempotency Store', domain: 'idemp.com' }).returning('*');
        storeId = store.id;
        const [shopper] = await trx('shoppers').insert({ store_id: storeId }).returning('*');
        shopperId = shopper.id;
      });

      // Insert first message log in Store context
      await withStoreContextApp(storeId, async (trx) => {
        await trx('message_logs').insert({
          store_id: storeId,
          shopper_id: shopperId,
          channel: 'whatsapp',
          provider: 'meta',
          template_id: 'browse_recovery_v1',
          idempotency_key: idempotencyKey,
          status: 'sent',
        });
      });

      // Insert duplicate log using same idempotency key - should throw unique violation
      const executeDuplicate = withStoreContextApp(storeId, async (trx) => {
        await trx('message_logs').insert({
          store_id: storeId,
          shopper_id: shopperId,
          channel: 'whatsapp',
          provider: 'meta',
          template_id: 'browse_recovery_v1',
          idempotency_key: idempotencyKey,
          status: 'sent',
        });
      });

      await expect(executeDuplicate).rejects.toThrow();
    });
  });

  describe('ClickHouse Ingestion & Columnar Aggregation', () => {
    it('should ingest raw event batches and verify MV summary outputs', async () => {
      const tenantId = '00000000-0000-0000-0000-000000000099';
      const shopperId = '00000000-0000-0000-0000-000000000001';
      const sessionId = '00000000-0000-0000-0000-000000000002';
      const logDate = '2026-08-15';

      const mockEvents: EnrichedEvent[] = [
        {
          eventTime: '2026-08-15T10:00:00.000Z',
          eventId: '00000000-0000-0000-0000-000000000001',
          tenantId,
          sessionId,
          shopperId,
          eventType: 'product_view',
          sdkVersion: '1.0.0',
          pageUrl: 'https://shop.com/prod-1',
          productId: 'p-black-shirt',
          productPrice: 1999.00,
          productCategories: ['shirts', 'black-clothing'],
          productName: 'Oversized Black T-Shirt',
        },
        {
          eventTime: '2026-08-15T10:05:00.000Z',
          eventId: '00000000-0000-0000-0000-000000000002',
          tenantId,
          sessionId,
          shopperId,
          eventType: 'product_view',
          sdkVersion: '1.0.0',
          pageUrl: 'https://shop.com/prod-1',
          productId: 'p-black-shirt',
          productPrice: 1999.00,
          productCategories: ['shirts', 'black-clothing'],
          productName: 'Oversized Black T-Shirt',
        }
      ];

      // Ingest event batches
      await insertAnalyticsEvents(mockEvents);

      const client = getClickHouseClient();

      // Query raw events count
      const rawResult = await client.query({
        query: `SELECT count() as count FROM events_analytics WHERE tenant_id = '${tenantId}'`,
        format: 'JSONEachRow',
      });
      const rawCount = (await rawResult.json<any>())[0].count;
      expect(parseInt(rawCount, 10)).toBe(2);

      // Query daily aggregated stats table generated via the Materialized View
      // ClickHouse AggregatingMergeTree requires uniqMerge and sum to retrieve correct aggregate values
      const aggResult = await client.query({
        query: `
          SELECT
            uniqMerge(unique_visitors) as unique_shoppers,
            sum(event_count) as total_events
          FROM daily_analytics_aggregates
          WHERE tenant_id = '${tenantId}' AND log_date = '${logDate}' AND event_type = 'product_view'
          GROUP BY tenant_id, log_date, event_type
        `,
        format: 'JSONEachRow',
      });
      
      const aggRows = await aggResult.json<any>();
      expect(aggRows.length).toBe(1);
      expect(parseInt(aggRows[0].unique_shoppers, 10)).toBe(1); // 1 unique shopper (shopperId)
      expect(parseInt(aggRows[0].total_events, 10)).toBe(2);    // 2 total product_view events
    });
  });

  describe('PII Cryptography & Hashing', () => {
    it('should hash identifiers deterministically in lowercase', () => {
      const email1 = '  TESTer@Revynta.com ';
      const email2 = 'tester@revynta.com';
      const hash1 = hashIdentifier(email1);
      const hash2 = hashIdentifier(email2);

      expect(hash1).toBe(hash2);
      expect(hash1).toBe('709985f2e8cea3a280d73d5c634a24281814f527d6b1b335f244adcba1e4dd4f');
    });

    it('should encrypt and decrypt values using AES-256-GCM successfully', () => {
      const sensitivePhone = '+919999999999';
      const encrypted = encryptPII(sensitivePhone);
      
      expect(encrypted).not.toBe(sensitivePhone);
      expect(encrypted.split(':').length).toBe(3); // [iv, tag, ciphertext]

      const decrypted = decryptPII(encrypted);
      expect(decrypted).toBe(sensitivePhone);
    });

    it('should fail decryption if payload is malformed', () => {
      expect(() => decryptPII('invalid-payload')).toThrow();
    });
  });
});
