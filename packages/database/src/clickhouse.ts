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
          event_count SimpleAggregateFunction(sum, UInt64)
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
          toUInt64(count()) AS event_count
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
    event_timestamp: event.eventTime ? event.eventTime.replace('T', ' ').replace('Z', '') : new Date().toISOString().replace('T', ' ').replace('Z', ''),
    event_id: event.eventId,
    tenant_id: event.tenantId,
    session_id: event.sessionId,
    shopper_id: event.shopperId,
    visitor_id: (event as any).visitorId || event.shopperId,
    event_type: event.eventType,
    page_url: event.pageUrl || '',
    referrer: event.referrer || '',
    product_id: event.productId || (event.metadata as any)?.productName || '',
    category: Array.isArray(event.productCategories) ? event.productCategories.join(',') : '',
    price: typeof event.productPrice === 'number' ? event.productPrice : 0,
    metadata: event.metadata ? JSON.stringify(event.metadata) : '{}',
  }));

  await client.insert({
    table: 'events_analytics',
    values: rows,
    format: 'JSONEachRow',
  });
}

/**
 * Retrieves recency-weighted trending products for a tenant from ClickHouse
 */
export async function getTrendingProductsFromCH(
  tenantId: string,
  limit: number = 10,
  days: number = 7
): Promise<Array<{ productId: string; score: number }>> {
  try {
    const client = getClickHouseClient();
    const query = `
      SELECT
        productId,
        sum(
          case
            when event_type = 'purchase' then 10.0
            when event_type = 'cart_add' then 5.0
            when event_type = 'product_view' then 1.0
            else 0.5
          end * exp(-0.1 * dateDiff('day', toDate(event_time), today()))
        ) as trend_score
      FROM events_analytics
      WHERE tenant_id = {tenantId:UUID}
        AND productId != ''
        AND event_time >= now() - INTERVAL {days:UInt32} DAY
      GROUP BY productId
      ORDER BY trend_score DESC
      LIMIT {limit:UInt32}
    `;

    const result = await client.query({
      query,
      query_params: { tenantId, days, limit },
      format: 'JSONEachRow',
    });

    const dataset = (await result.json()) as any[];
    return dataset.map((row) => ({
      productId: row.productId,
      score: parseFloat(row.trend_score),
    }));
  } catch (error) {
    logger.warn({ err: error, tenantId }, 'ClickHouse trending products query failed, returning empty list');
    return [];
  }
}

/**
 * Retrieves overall popular products for a tenant from ClickHouse
 */
export async function getPopularProductsFromCH(
  tenantId: string,
  limit: number = 10
): Promise<Array<{ productId: string; count: number }>> {
  try {
    const client = getClickHouseClient();
    const query = `
      SELECT
        productId,
        count() as interaction_count
      FROM events_analytics
      WHERE tenant_id = {tenantId:UUID}
        AND productId != ''
      GROUP BY productId
      ORDER BY interaction_count DESC
      LIMIT {limit:UInt32}
    `;

    const result = await client.query({
      query,
      query_params: { tenantId, limit },
      format: 'JSONEachRow',
    });

    const dataset = (await result.json()) as any[];
    return dataset.map((row) => ({
      productId: row.productId,
      count: parseInt(row.interaction_count, 10),
    }));
  } catch (error) {
    logger.warn({ err: error, tenantId }, 'ClickHouse popular products query failed, returning empty list');
    return [];
  }
}

/**
 * Retrieves co-occurring products viewed/interacted within the same session/shopper (Collaborative signal)
 */
export async function getCoOccurrenceProductsFromCH(
  tenantId: string,
  targetProductId: string,
  limit: number = 10
): Promise<Array<{ productId: string; score: number }>> {
  try {
    const client = getClickHouseClient();
    const query = `
      SELECT
        productId,
        count(DISTINCT session_id) as co_occurrence_count
      FROM events_analytics
      WHERE tenant_id = {tenantId:UUID}
        AND productId != ''
        AND productId != {targetProductId:String}
        AND session_id IN (
          SELECT DISTINCT session_id
          FROM events_analytics
          WHERE tenant_id = {tenantId:UUID}
            AND productId = {targetProductId:String}
        )
      GROUP BY productId
      ORDER BY co_occurrence_count DESC
      LIMIT {limit:UInt32}
    `;

    const result = await client.query({
      query,
      query_params: { tenantId, targetProductId, limit },
      format: 'JSONEachRow',
    });

    const dataset = (await result.json()) as any[];
    return dataset.map((row) => ({
      productId: row.productId,
      score: parseInt(row.co_occurrence_count, 10),
    }));
  } catch (error) {
    logger.warn({ err: error, tenantId, targetProductId }, 'ClickHouse co-occurrence query failed, returning empty list');
    return [];
  }
}

