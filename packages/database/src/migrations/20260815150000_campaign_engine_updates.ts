import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Add deleted_at and frequency_cap columns to campaigns
  await knex.schema.alterTable('campaigns', (table) => {
    table.timestamp('deleted_at');
    table.integer('frequency_cap_limit');
    table.integer('frequency_cap_window_seconds');
  });

  // 2. Add composite index on message_logs for fast cooldown/frequency cap lookup
  await knex.schema.alterTable('message_logs', (table) => {
    table.index(['store_id', 'shopper_id', 'campaign_id', 'created_at'], 'idx_msg_logs_cooldown');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('message_logs', (table) => {
    table.dropIndex(['store_id', 'shopper_id', 'campaign_id', 'created_at'], 'idx_msg_logs_cooldown');
  });
  
  await knex.schema.alterTable('campaigns', (table) => {
    table.dropColumn('frequency_cap_window_seconds');
    table.dropColumn('frequency_cap_limit');
    table.dropColumn('deleted_at');
  });
}
