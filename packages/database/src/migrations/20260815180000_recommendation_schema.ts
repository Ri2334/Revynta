import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Create products table with store/tenant isolation
  await knex.schema.createTable('products', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.string('sku').notNullable();
    table.string('name').notNullable();
    table.jsonb('categories').notNullable().defaultTo('[]');
    table.string('brand');
    table.decimal('price', 12, 4).notNullable().defaultTo(0);
    table.string('status').notNullable().defaultTo('active'); // 'active', 'inactive', 'out_of_stock'
    table.jsonb('metadata').notNullable().defaultTo('{}'); // tags, color, subcategory, attributes
    table.timestamps(true, true);
    table.timestamp('deleted_at');
    table.unique(['store_id', 'sku']);
  });

  // 2. Create recommendation_logs table for audit & evaluation metrics
  await knex.schema.createTable('recommendation_logs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.uuid('shopper_id').references('id').inTable('shoppers').onDelete('SET NULL');
    table.string('session_id');
    table.string('strategy').notNullable();
    table.string('model_version').notNullable().defaultTo('hybrid-v1');
    table.jsonb('recommended_products').notNullable().defaultTo('[]');
    table.jsonb('metadata').notNullable().defaultTo('{}');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // 3. Create recommendation_events table for tracking impressions, clicks, conversions
  await knex.schema.createTable('recommendation_events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.uuid('shopper_id').references('id').inTable('shoppers').onDelete('SET NULL');
    table.uuid('product_id').notNullable().references('id').inTable('products').onDelete('CASCADE');
    table.string('event_type').notNullable(); // 'recommendation_impression', 'recommendation_click', 'recommendation_conversion'
    table.string('strategy').notNullable();
    table.string('recommendation_id');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // Indexes for query performance
  await knex.schema.alterTable('products', (table) => {
    table.index(['store_id', 'status']);
    table.index(['store_id', 'brand']);
  });

  await knex.schema.alterTable('recommendation_logs', (table) => {
    table.index(['store_id', 'created_at']);
    table.index(['store_id', 'shopper_id']);
  });

  await knex.schema.alterTable('recommendation_events', (table) => {
    table.index(['store_id', 'event_type', 'created_at']);
    table.index(['store_id', 'strategy']);
  });

  // Enable RLS for multi-tenant isolation
  const newTables = ['products', 'recommendation_logs', 'recommendation_events'];
  for (const tableName of newTables) {
    await knex.raw(`
      ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY;
      CREATE POLICY ${tableName}_store_isolation ON ${tableName}
        FOR ALL
        USING (store_id = NULLIF(current_setting('app.current_store_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'true');
    `);
  }

  // Grant permissions to revynta_app role if it exists
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
  await knex.schema.dropTableIfExists('recommendation_events');
  await knex.schema.dropTableIfExists('recommendation_logs');
  await knex.schema.dropTableIfExists('products');
}
