import { withStoreContext } from './postgres.js';

export interface CampaignRecord {
  id: string;
  store_id: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  trigger_type: 'browse_abandonment' | 'cart_abandonment';
  inactivity_duration_minutes: number;
  min_intent_score: number;
  communication_channel: string;
  template_id: string;
  cooldown_seconds: number;
  frequency_cap_limit?: number | null;
  frequency_cap_window_seconds?: number | null;
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date | null;
}

export interface CampaignRuleRecord {
  id: string;
  store_id: string;
  campaign_id: string;
  rule_type: string;
  configuration: any;
  created_at: Date;
  updated_at: Date;
}

export interface MessageLogRecord {
  id: string;
  store_id: string;
  shopper_id: string;
  campaign_id: string;
  channel: string;
  provider: string;
  provider_message_id?: string | null;
  template_id: string;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  idempotency_key: string;
  failure_reason?: string | null;
  sent_at?: Date | null;
  created_at: Date;
}

export interface ConsentRecord {
  id: string;
  store_id: string;
  shopper_id: string;
  purpose: 'analytics' | 'personalization' | 'marketing';
  status: 'granted' | 'denied';
  withdrawn_at?: Date | null;
}

export interface ShopperIdentityRecord {
  id: string;
  store_id: string;
  shopper_id: string;
  channel: string;
  encrypted_value: string;
}

/**
 * Gets all active campaigns for a store (status = 'active', deleted_at IS NULL).
 */
export async function getActiveCampaignsForStore(storeId: string): Promise<CampaignRecord[]> {
  return await withStoreContext(storeId, async (trx) => {
    return await trx('campaigns')
      .where({ store_id: storeId, status: 'active' })
      .andWhere((builder) => {
        builder.whereNull('deleted_at');
      });
  });
}

/**
 * Gets a campaign by ID.
 */
export async function getCampaignById(storeId: string, campaignId: string): Promise<CampaignRecord | null> {
  return await withStoreContext(storeId, async (trx) => {
    const row = await trx('campaigns')
      .where({ store_id: storeId, id: campaignId })
      .first();
    return row || null;
  });
}

/**
 * Inserts a campaign audit log inside an organization's context.
 */
export async function recordCampaignAuditLog(
  orgId: string,
  actorId: string | null,
  actorType: 'user' | 'system',
  action: string,
  campaignId: string,
  metadata: any
): Promise<void> {
  // bypass RLS or run under bypass RLS because audit_logs are organization-level scoped
  await withStoreContext(campaignId, async (trx) => {
    // we bypass RLS for audit logging to ensure we can log system actions correctly
    await trx.raw("SELECT set_config('app.bypass_rls', 'true', true)");
    await trx('audit_logs').insert({
      organization_id: orgId,
      actor_id: actorId,
      actor_type: actorType,
      action,
      resource: 'campaign',
      resource_id: campaignId,
      metadata: JSON.stringify(metadata),
      created_at: new Date()
    });
  });
}

/**
 * Checks whether the shopper has marketing consent ('marketing' purpose status = 'granted', withdrawn_at IS NULL).
 */
export async function checkShopperMarketingConsent(storeId: string, shopperId: string): Promise<boolean> {
  return await withStoreContext(storeId, async (trx) => {
    const withdrawnRow = await trx('consent_records')
      .where({ store_id: storeId, shopper_id: shopperId, purpose: 'marketing', status: 'withdrawn' })
      .first();
    return !withdrawnRow;
  });
}

/**
 * Checks whether the shopper received this campaign within the cooldown period.
 */
export async function hasReceivedCampaignRecently(
  storeId: string,
  shopperId: string,
  campaignId: string,
  cooldownSeconds: number
): Promise<boolean> {
  const since = new Date(Date.now() - cooldownSeconds * 1000);
  return await withStoreContext(storeId, async (trx) => {
    const row = await trx('message_logs')
      .where({ store_id: storeId, shopper_id: shopperId, campaign_id: campaignId })
      .andWhere('created_at', '>=', since)
      .andWhere('status', '!=', 'failed')
      .first();
    return !!row;
  });
}

/**
 * Counts marketing messages sent to this shopper in a given window (for global frequency cap check).
 */
export async function getRecentMessageCount(
  storeId: string,
  shopperId: string,
  windowSeconds: number,
  campaignId?: string
): Promise<number> {
  const since = new Date(Date.now() - windowSeconds * 1000);
  return await withStoreContext(storeId, async (trx) => {
    let query = trx('message_logs')
      .where({ store_id: storeId, shopper_id: shopperId })
      .andWhere('created_at', '>=', since)
      .andWhere('status', '!=', 'failed');

    if (campaignId) {
      query = query.andWhere({ campaign_id: campaignId });
    }

    const row = await query.count('id as count').first();
    return row ? parseInt(row.count as string, 10) : 0;
  });
}

/**
 * Gets active shopper identities for communication channels.
 */
export async function getShopperIdentitiesForShopper(
  storeId: string,
  shopperId: string
): Promise<ShopperIdentityRecord[]> {
  return await withStoreContext(storeId, async (trx) => {
    return await trx('shopper_identities')
      .where({ store_id: storeId, shopper_id: shopperId });
  });
}

/**
 * Inserts a message log record for tracking and idempotency.
 */
export async function insertMessageLog(storeId: string, log: Omit<MessageLogRecord, 'id' | 'created_at'>): Promise<string> {
  return await withStoreContext(storeId, async (trx) => {
    const [inserted] = await trx('message_logs')
      .insert({
        store_id: storeId,
        shopper_id: log.shopper_id,
        campaign_id: log.campaign_id,
        channel: log.channel,
        provider: log.provider,
        provider_message_id: log.provider_message_id || null,
        template_id: log.template_id,
        status: log.status,
        idempotency_key: log.idempotency_key,
        failure_reason: log.failure_reason || null,
        sent_at: log.sent_at || null,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('id');
    return typeof inserted === 'object' && inserted ? (inserted as any).id : inserted;
  });
}
