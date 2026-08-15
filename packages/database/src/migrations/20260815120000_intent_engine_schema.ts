import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Shopper Intent durable table
  await knex.schema.createTable('shopper_intent', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.uuid('shopper_id').notNullable().references('id').inTable('shoppers').onDelete('CASCADE');
    table.integer('intent_score').notNullable().defaultTo(0);
    table.string('intent_segment').notNullable().defaultTo('low');
    table.jsonb('explanations').defaultTo('[]');
    table.string('model_version').notNullable().defaultTo('v1');
    table.timestamps(true, true);
    table.unique(['store_id', 'shopper_id']);
  });

  // 2. Purchase suppression durable table
  await knex.schema.createTable('purchase_suppression', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.uuid('shopper_id').notNullable().references('id').inTable('shoppers').onDelete('CASCADE');
    table.timestamp('suppressed_at').defaultTo(knex.fn.now());
    table.timestamp('expires_at').notNullable();
    table.string('model_version').notNullable().defaultTo('v1');
    table.unique(['store_id', 'shopper_id']);
  });

  // 3. Durable Event Deduplication Table
  await knex.schema.createTable('event_dedup', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.string('consumer_group').notNullable();
    table.string('event_id').notNullable();
    table.timestamp('processed_at').defaultTo(knex.fn.now());
    table.unique(['store_id', 'consumer_group', 'event_id']);
  });

  // Indexes for fast lookup
  await knex.schema.alterTable('shopper_intent', (table) => {
    table.index(['store_id', 'shopper_id']);
    table.index('intent_score');
  });
  await knex.schema.alterTable('purchase_suppression', (table) => {
    table.index(['store_id', 'shopper_id']);
    table.index('expires_at');
  });
  await knex.schema.alterTable('event_dedup', (table) => {
    table.index(['store_id', 'consumer_group', 'event_id']);
  });

  // Enable RLS for multi-tenant isolation
  const newTables = ['shopper_intent', 'purchase_suppression', 'event_dedup'];
  for (const tableName of newTables) {
    await knex.raw(`
      ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY;
      CREATE POLICY ${tableName}_store_isolation ON ${tableName}
        FOR ALL
        USING (store_id = NULLIF(current_setting('app.current_store_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'true');
    `);
  }

  // Grant privileges to application user if role exists
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'revynta_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO revynta_app;
      END IF;
    END
    $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('event_dedup');
  await knex.schema.dropTableIfExists('purchase_suppression');
  await knex.schema.dropTableIfExists('shopper_intent');
}
