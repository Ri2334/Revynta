import knex, { type Knex } from 'knex';
import knexConfig from './knexfile.js';
import { config } from '@revynta/config';
import { logger } from '@revynta/observability';

const env = config.env === 'test' ? 'test' : config.env === 'production' ? 'production' : 'development';
const activeConfig = knexConfig[env];

if (!activeConfig) {
  throw new Error(`Knex configuration not found for environment: ${env}`);
}

export const postgres = knex(activeConfig);

/**
 * Runs PostgreSQL health check.
 */
export async function checkPostgresHealth(): Promise<boolean> {
  try {
    await postgres.raw('SELECT 1');
    return true;
  } catch (error) {
    logger.error(error as Error, 'PostgreSQL healthcheck failed');
    return false;
  }
}

/**
 * Closes the PostgreSQL connection pool.
 */
export async function disconnectPostgres(): Promise<void> {
  await postgres.destroy();
  logger.info('PostgreSQL connection pool closed.');
}

/**
 * Executes queries inside a PostgreSQL transaction set with the active store_id.
 * Enforces RLS: Appends "SET LOCAL app.current_store_id" at transaction startup.
 * Using SET LOCAL guarantees the parameter is cleared upon commit or rollback,
 * preventing connection pool leakages.
 */
export async function withStoreContext<T>(
  storeId: string,
  callback: (trx: Knex.Transaction) => Promise<T>
): Promise<T> {
  return postgres.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.current_store_id', ?, true)", [storeId]);
    return callback(trx);
  });
}

/**
 * Executes queries inside a PostgreSQL transaction set with the active organization_id.
 * Enforces RLS: Appends "SET LOCAL app.current_org_id" at transaction startup.
 */
export async function withOrgContext<T>(
  orgId: string,
  callback: (trx: Knex.Transaction) => Promise<T>
): Promise<T> {
  return postgres.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.current_org_id', ?, true)", [orgId]);
    return callback(trx);
  });
}

/**
 * Executes queries with administrative credentials, bypassing RLS gates.
 * Enforces auditability: Appends "SET LOCAL app.bypass_rls = 'true'".
 */
export async function withAdminContext<T>(
  callback: (trx: Knex.Transaction) => Promise<T>
): Promise<T> {
  return postgres.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.bypass_rls', 'true', true)");
    return callback(trx);
  });
}
