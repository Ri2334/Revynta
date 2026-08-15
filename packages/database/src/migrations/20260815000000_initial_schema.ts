import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Create organizations
  await knex.schema.createTable('organizations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name').notNullable();
    table.timestamps(true, true);
  });

  // 2. Create stores / tenants
  await knex.schema.createTable('stores', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.string('name').notNullable();
    table.string('domain').notNullable();
    table.timestamps(true, true);
  });
  
  // 3. Create users
  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('email').unique().notNullable();
    table.string('password_hash').notNullable();
    table.string('first_name');
    table.string('last_name');
    table.timestamps(true, true);
  });

  // 4. Create memberships
  await knex.schema.createTable('memberships', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('role').notNullable().defaultTo('member'); // 'owner', 'admin', 'member'
    table.timestamps(true, true);
    table.unique(['organization_id', 'user_id']);
  });
  
  // 5. Create api_keys
  await knex.schema.createTable('api_keys', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.string('key_prefix', 8).notNullable();
    table.string('key_hash', 64).unique().notNullable(); // SHA-256
    table.string('name').notNullable();
    table.string('status').notNullable().defaultTo('active'); // 'active', 'revoked', 'expired'
    table.timestamp('expires_at');
    table.timestamp('last_used_at');
    table.timestamp('revoked_at');
    table.timestamps(true, true);
  });

  // 6. Create shoppers
  await knex.schema.createTable('shoppers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.integer('intent_score').defaultTo(0).notNullable();
    table.string('intent_segment').defaultTo('low').notNullable();
    table.timestamps(true, true);
  });

  // 7. Create shopper_identities
  await knex.schema.createTable('shopper_identities', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.uuid('shopper_id').notNullable().references('id').inTable('shoppers').onDelete('CASCADE');
    table.string('channel').notNullable(); // 'whatsapp', 'email', 'sms'
    table.string('identifier_hash', 64).notNullable(); // SHA-256
    table.text('encrypted_value').notNullable(); // AES-256-GCM
    table.timestamps(true, true);
    table.unique(['store_id', 'shopper_id', 'channel', 'identifier_hash']);
  });

  // 8. Create consent_records
  await knex.schema.createTable('consent_records', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.uuid('shopper_id').notNullable().references('id').inTable('shoppers').onDelete('CASCADE');
    table.string('purpose').notNullable(); // 'analytics', 'personalization', 'marketing'
    table.string('status').notNullable().defaultTo('granted'); // 'granted', 'denied'
    table.string('source').notNullable(); // e.g. 'sdk_consent_banner'
    table.string('policy_version').notNullable();
    table.timestamp('withdrawn_at');
    table.timestamps(true, true);
    table.unique(['store_id', 'shopper_id', 'purpose']);
  });

  // 9. Create sessions
  await knex.schema.createTable('sessions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.uuid('shopper_id').notNullable().references('id').inTable('shoppers').onDelete('CASCADE');
    table.string('session_token').unique().notNullable();
    table.timestamp('last_active_at').defaultTo(knex.fn.now());
    table.timestamps(true, true);
  });

  // 10. Create campaigns
  await knex.schema.createTable('campaigns', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.string('name').notNullable();
    table.string('status').notNullable().defaultTo('draft'); // 'draft', 'active', 'paused'
    table.string('trigger_type').notNullable().defaultTo('browse_abandonment');
    table.integer('inactivity_duration_minutes').notNullable().defaultTo(30);
    table.integer('min_intent_score').notNullable().defaultTo(50);
    table.string('communication_channel').notNullable().defaultTo('whatsapp');
    table.string('template_id').notNullable();
    table.integer('cooldown_seconds').notNullable().defaultTo(604800);
    table.timestamps(true, true);
  });

  // 11. Create campaign_rules
  await knex.schema.createTable('campaign_rules', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.uuid('campaign_id').notNullable().references('id').inTable('campaigns').onDelete('CASCADE');
    table.string('rule_type').notNullable();
    table.jsonb('configuration').notNullable();
    table.timestamps(true, true);
  });

  // 12. Create message_logs
  await knex.schema.createTable('message_logs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.uuid('shopper_id').notNullable().references('id').inTable('shoppers').onDelete('CASCADE');
    table.uuid('campaign_id').references('id').inTable('campaigns').onDelete('SET NULL');
    table.string('channel').notNullable();
    table.string('provider').notNullable();
    table.string('provider_message_id').unique();
    table.string('template_id').notNullable();
    table.string('status').notNullable().defaultTo('pending'); // 'pending', 'sent', 'delivered', 'read', 'failed'
    table.string('idempotency_key').unique().notNullable(); // campaign_id:shopper_id:session_id:date
    table.string('failure_reason');
    table.timestamp('sent_at');
    table.timestamp('delivered_at');
    table.timestamp('read_at');
    table.timestamp('failed_at');
    table.timestamps(true, true);
  });

  // 13. Create integrations
  await knex.schema.createTable('integrations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('store_id').notNullable().references('id').inTable('stores').onDelete('CASCADE');
    table.string('provider').notNullable();
    table.jsonb('configuration').notNullable();
    table.string('status').notNullable().defaultTo('active');
    table.timestamps(true, true);
  });

  // 14. Create audit_logs
  await knex.schema.createTable('audit_logs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.uuid('actor_id').references('id').inTable('users').onDelete('SET NULL');
    table.string('actor_type').notNullable(); // 'user', 'system'
    table.string('action').notNullable();
    table.string('resource').notNullable();
    table.string('resource_id').notNullable();
    table.jsonb('metadata').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // 15. Create indexes based on query patterns
  await knex.schema.alterTable('stores', (table) => {
    table.index(['organization_id']);
  });
  await knex.schema.alterTable('memberships', (table) => {
    table.index(['user_id']);
  });
  await knex.schema.alterTable('api_keys', (table) => {
    table.index(['store_id', 'status']);
  });
  await knex.schema.alterTable('shoppers', (table) => {
    table.index(['store_id']);
  });
  await knex.schema.alterTable('shopper_identities', (table) => {
    table.index(['store_id', 'shopper_id']);
    table.index(['store_id', 'channel', 'identifier_hash'], 'idx_identities_lookup');
  });
  await knex.schema.alterTable('consent_records', (table) => {
    table.index(['store_id', 'shopper_id']);
  });
  await knex.schema.alterTable('sessions', (table) => {
    table.index(['store_id', 'shopper_id']);
    table.index(['store_id', 'session_token']);
  });
  await knex.schema.alterTable('campaigns', (table) => {
    table.index(['store_id', 'status']);
  });
  await knex.schema.alterTable('campaign_rules', (table) => {
    table.index(['store_id', 'campaign_id']);
  });
  await knex.schema.alterTable('message_logs', (table) => {
    table.index(['store_id', 'shopper_id']);
    table.index(['store_id', 'status']);
  });
  await knex.schema.alterTable('integrations', (table) => {
    table.index(['store_id', 'provider']);
  });
  await knex.schema.alterTable('audit_logs', (table) => {
    table.index(['organization_id', 'created_at']);
  });

  // 16. Enable RLS and define Policies
  // organization-level isolated tables
  await knex.raw(`
    ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
    ALTER TABLE stores FORCE ROW LEVEL SECURITY;
    CREATE POLICY stores_org_isolation ON stores
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'true');

    ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
    ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
    CREATE POLICY memberships_org_isolation ON memberships
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'true');
  `);

  // store-level isolated tables
  const storeIsolatedTables = [
    'api_keys',
    'shoppers',
    'shopper_identities',
    'consent_records',
    'sessions',
    'campaigns',
    'campaign_rules',
    'message_logs',
    'integrations'
  ];

  for (const tableName of storeIsolatedTables) {
    await knex.raw(`
      ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY;
      CREATE POLICY ${tableName}_store_isolation ON ${tableName}
        FOR ALL
        USING (store_id = NULLIF(current_setting('app.current_store_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'true');
    `);
  }

  // audit_logs isolated by organization_id
  await knex.raw(`
    ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
    CREATE POLICY audit_logs_org_isolation ON audit_logs
      FOR ALL
      USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid OR current_setting('app.bypass_rls', true) = 'true');
  `);

  // Create restricted app user for RLS enforcement
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'revynta_app') THEN
        CREATE ROLE revynta_app WITH LOGIN PASSWORD 'revynta_app_pass';
      END IF;
    END
    $$;
    GRANT USAGE ON SCHEMA public TO revynta_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO revynta_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO revynta_app;
  `);
}

export async function down(knex: Knex): Promise<void> {
  const tables = [
    'audit_logs',
    'integrations',
    'message_logs',
    'campaign_rules',
    'campaigns',
    'sessions',
    'consent_records',
    'shopper_identities',
    'shoppers',
    'api_keys',
    'memberships',
    'users',
    'stores',
    'organizations'
  ];

  for (const tableName of tables) {
    await knex.raw(`DROP TABLE IF EXISTS ${tableName} CASCADE;`);
  }
}
