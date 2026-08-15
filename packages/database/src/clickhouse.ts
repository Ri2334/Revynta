import { createClient, ClickHouseClient } from '@clickhouse/client';
import { config } from '@revynta/config';
import { logger } from '@revynta/observability';
import { EnrichedEvent } from '@revynta/shared-types';

export const clickhouse: ClickHouseClient = createClient({
  url: config.clickhouse.url,
  username: config.clickhouse.user,
  password: config.clickhouse.password,
  database: '', // Start with empty database to ensure we can create it
});

// ClickHouse client bound to target database
let dbClient: ClickHouseClient | null = null;

export function getClickHouseClient(): ClickHouseClient {
  if (!dbClient) {
    dbClient = createClient({
      url: config.clickhouse.url,
      username: config.clickhouse.user,
      password: config.clickhouse.password,
      database: config.clickhouse.database,
    });
  }
  return dbClient;
}

/**
 * Validates connection health for ClickHouse
 */
export async function checkClickHouseHealth(): Promise<boolean> {
  try {
    const client = getClickHouseClient();
    const result = await client.ping();
    return result.success;
  } catch (error) {
    logger.error(error as Error, 'ClickHouse healthcheck failed');
    return false;
  }
}

/**
 * Initializes ClickHouse database, event table, summary tables, and materialized views
 */
export async function initClickHouseSchema(): Promise<void> {
  try {
    // 1. Create target database if not exists
    await clickhouse.exec({
      query: `CREATE DATABASE IF NOT EXISTS ${config.clickhouse.database}`,
    });
    logger.info(`ClickHouse database '${config.clickhouse.database}' created or verified.`);

    const client = getClickHouseClient();

    // 2. Create raw events columnar log table
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS events_analytics (
          event_time DateTime64(3, 'UTC') NOT NULL,
          event_id UUID NOT NULL,
          tenant_id UUID NOT NULL,
          session_id UUID NOT NULL,
          shopper_id UUID NOT NULL,
          event_type LowCardinality(String) NOT NULL,
          sdk_version LowCardinality(String) NOT NULL,
          page_url String,
          referrer String,
          user_agent String,
          ip_address String,
          country LowCardinality(String),
          productId String,
          productPrice Decimal(18, 4),
          productCategories Array(String),
          productName String,
          query String,
          metadata String
        ) ENGINE = MergeTree()
        PARTITION BY toYYYYMM(event_time)
        PRIMARY KEY (tenant_id, event_type, event_time, shopper_id)
        ORDER BY (tenant_id, event_type, event_time, shopper_id)
        SETTINGS index_granularity = 8192;
      `,
    });
    logger.info("ClickHouse raw 'events_analytics' table verified.");

    // 3. Create AggregatingMergeTree to store pre-aggregated visitor & event logs
    await client.exec({
      query: `
        CREATE TABLE IF NOT EXISTS daily_analytics_aggregates (
          log_date Date,
          tenant_id UUID,
          event_type LowCardinality(String),
          unique_visitors AggregateFunction(uniq, UUID),
          event_count UInt64
        ) ENGINE = AggregatingMergeTree()
        PARTITION BY toYYYYMM(log_date)
        ORDER BY (tenant_id, event_type, log_date);
      `,
    });
    logger.info("ClickHouse summary 'daily_analytics_aggregates' table verified.");

    // 4. Create Materialized View to write aggregates on raw event insertions
    await client.exec({
      query: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS daily_analytics_aggregates_mv
        TO daily_analytics_aggregates AS
        SELECT
          toDate(event_time) AS log_date,
          tenant_id,
          event_type,
          uniqState(shopper_id) AS unique_visitors,
          count() AS event_count
        FROM events_analytics
        GROUP BY log_date, tenant_id, event_type;
      `,
    });
    logger.info("ClickHouse Materialized View 'daily_analytics_aggregates_mv' verified.");
  } catch (error) {
    logger.error(error as Error, 'Failed to initialize ClickHouse database schemas');
    throw error;
  }
}

/**
 * Inserts a batch of enriched events into ClickHouse events_analytics
 */
export async function insertAnalyticsEvents(events: EnrichedEvent[]): Promise<void> {
  if (events.length === 0) return;

  const client = getClickHouseClient();

  // Convert array of events to ClickHouse compatible JSONEachRow payload
  const rows = events.map((event) => ({
    event_time: event.eventTime.replace('T', ' ').replace('Z', ''),
    event_id: event.eventId,
    tenant_id: event.tenantId,
    session_id: event.sessionId,
    shopper_id: event.shopperId,
    event_type: event.eventType,
    sdk_version: event.sdkVersion,
    page_url: event.pageUrl || null,
    referrer: event.referrer || null,
    user_agent: event.userAgent || null,
    ip_address: event.ipAddress || null,
    country: event.country || null,
    productId: event.productId || '',
    productPrice: event.productPrice || 0,
    productCategories: event.productCategories || [],
    productName: event.productName || '',
    query: event.query || '',
    metadata: event.metadata ? JSON.stringify(event.metadata) : '{}',
  }));

  await client.insert({
    table: 'events_analytics',
    values: rows,
    format: 'JSONEachRow',
  });
}
