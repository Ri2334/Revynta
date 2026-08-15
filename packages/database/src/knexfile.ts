import type { Knex } from 'knex';
import { fileURLToPath } from 'url';
import path from 'path';
import { config } from '@revynta/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDirectory = path.resolve(__dirname, 'migrations');

const knexConfig: Record<string, Knex.Config> = {
  development: {
    client: 'pg',
    connection: {
      host: config.postgres.host,
      port: config.postgres.port,
      user: config.postgres.user,
      password: config.postgres.password,
      database: config.postgres.database,
    },
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      tableName: 'knex_migrations',
      directory: migrationsDirectory,
      loadExtensions: ['.js'],
    },
  },
  test: {
    client: 'pg',
    connection: {
      host: config.postgres.host,
      port: config.postgres.port,
      user: config.postgres.user,
      password: config.postgres.password,
      database: config.postgres.database,
    },
    pool: {
      min: 1,
      max: 5,
    },
    migrations: {
      tableName: 'knex_migrations',
      directory: migrationsDirectory,
      loadExtensions: ['.js'],
    },
  },
  production: {
    client: 'pg',
    connection: {
      host: config.postgres.host,
      port: config.postgres.port,
      user: config.postgres.user,
      password: config.postgres.password,
      database: config.postgres.database,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    },
    pool: {
      min: 5,
      max: 30,
    },
    migrations: {
      tableName: 'knex_migrations',
      directory: migrationsDirectory,
      loadExtensions: ['.js'],
    },
  },
};

export default knexConfig;
