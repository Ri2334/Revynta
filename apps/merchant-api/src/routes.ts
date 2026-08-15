import { FastifyInstance } from 'fastify';
import { authenticateMerchant, authorizeRoles } from './middleware.js';
import { hashPassword, verifyPassword, signToken } from './auth-utils.js';
import {
  withStoreContext,
  withAdminContext,
  insertMessageLog,
  getCampaignById,
  encryptPII,
  decryptPII,
  getClickHouseClient,
  upsertProduct,
  getActiveProducts,
} from '@revynta/database';
import { HybridRecommendationModel } from '@revynta/recommendation-engine';
import crypto from 'crypto';

export async function routes(fastify: FastifyInstance): Promise<void> {
  // --- Public Auth Routes ---

  // POST /api/v1/auth/register
  fastify.post('/api/v1/auth/register', async (request, reply) => {
    const { email, password, firstName, lastName, organizationName, storeName, storeDomain } = request.body as any;

    if (!email || !password || !organizationName || !storeName || !storeDomain) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Missing required parameters' } });
    }

    try {
      const result = await withAdminContext(async (adminTrx: any) => {
        // Check if user already exists
        const existingUser = await adminTrx('users').where({ email }).first();
        if (existingUser) {
          throw new Error('User already exists');
        }

        const passwordHash = hashPassword(password);
        const [userRow] = await adminTrx('users')
          .insert({
            email,
            password_hash: passwordHash,
            first_name: firstName || null,
            last_name: lastName || null,
          })
          .returning('*');

        const [orgRow] = await adminTrx('organizations')
          .insert({ name: organizationName })
          .returning('*');

        const [storeRow] = await adminTrx('stores')
          .insert({
            organization_id: orgRow.id,
            name: storeName,
            domain: storeDomain,
          })
          .returning('*');

        await adminTrx('memberships').insert({
          organization_id: orgRow.id,
          user_id: userRow.id,
          role: 'owner', // Default first user as Owner
        });

        return { userId: userRow.id, email: userRow.email };
      });

      const sessionToken = signToken({ userId: result.userId, email: result.email });
      reply.setCookie('revynta_session', sessionToken, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 24 * 3600,
      });

      return reply.status(201).send({ data: { message: 'Registration successful', userId: result.userId } });
    } catch (err: any) {
      if (err.message === 'User already exists') {
        return reply.status(409).send({ error: { code: 'CONFLICT', message: err.message } });
      }
      fastify.log.error(err);
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Registration failed' } });
    }
  });

  // POST /api/v1/auth/login
  fastify.post('/api/v1/auth/login', async (request, reply) => {
    const { email, password } = request.body as any;

    if (!email || !password) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Missing email or password' } });
    }

    try {
      const user = await withAdminContext(async (adminTrx: any) => {
        return await adminTrx('users').where({ email }).first();
      });

      if (!user || !verifyPassword(password, user.password_hash)) {
        return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' } });
      }

      const sessionToken = signToken({ userId: user.id, email: user.email });
      reply.setCookie('revynta_session', sessionToken, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 24 * 3600,
      });

      return reply.status(200).send({ data: { message: 'Login successful', userId: user.id } });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Login failed' } });
    }
  });

  // POST /api/v1/auth/logout
  fastify.post('/api/v1/auth/logout', async (request, reply) => {
    reply.clearCookie('revynta_session', { path: '/' });
    return reply.status(200).send({ data: { message: 'Logged out successfully' } });
  });

  // --- Authenticated Merchant Dashboard Routes ---

  // GET /api/v1/auth/me
  fastify.get('/api/v1/auth/me', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    return reply.send({
      data: {
        userId: user.id,
        email: user.email,
        organizationId: user.organizationId,
        role: user.role,
        activeStoreId: user.activeStoreId,
        accessibleStoreIds: user.accessibleStoreIds,
      },
    });
  });

  // GET /api/v1/stores
  fastify.get('/api/v1/stores', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const stores = await withAdminContext(async (adminTrx: any) => {
      return await adminTrx('stores').where({ organization_id: user.organizationId });
    });
    return reply.send({ data: stores });
  });

  // GET /api/v1/stores/:id
  fastify.get('/api/v1/stores/:id', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as any;

    if (!user.accessibleStoreIds.includes(id)) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Access denied to store' } });
    }

    const store = await withAdminContext(async (adminTrx: any) => {
      return await adminTrx('stores').where({ id }).first();
    });
    return reply.send({ data: store });
  });

  // PUT /api/v1/stores/:id
  fastify.put('/api/v1/stores/:id', { preHandler: [authenticateMerchant, authorizeRoles(['owner', 'admin'])] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as any;
    const { name, domain } = request.body as any;

    if (!user.accessibleStoreIds.includes(id)) {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Access denied to store' } });
    }

    const updated = await withAdminContext(async (adminTrx: any) => {
      const [row] = await adminTrx('stores')
        .where({ id })
        .update({
          name: name || undefined,
          domain: domain || undefined,
          updated_at: new Date(),
        })
        .returning('*');
      return row;
    });

    return reply.send({ data: updated });
  });

  // --- Campaign Management Routes ---

  // GET /api/v1/campaigns
  fastify.get('/api/v1/campaigns', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;

    const campaigns = await withStoreContext(storeId, async (storeTrx: any) => {
      return await storeTrx('campaigns')
        .where({ store_id: storeId })
        .andWhere('deleted_at', null);
    });
    return reply.send({ data: campaigns });
  });

  // GET /api/v1/campaigns/:id
  fastify.get('/api/v1/campaigns/:id', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as any;
    const storeId = user.activeStoreId;

    const campaign = await withStoreContext(storeId, async (storeTrx: any) => {
      return await storeTrx('campaigns')
        .where({ id, store_id: storeId })
        .andWhere('deleted_at', null)
        .first();
    });

    if (!campaign) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }
    return reply.send({ data: campaign });
  });

  // POST /api/v1/campaigns
  fastify.post('/api/v1/campaigns', { preHandler: [authenticateMerchant, authorizeRoles(['owner', 'admin'])] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;
    const { name, triggerType, inactivityDurationMinutes, minIntentScore, communicationChannel, templateId, cooldownSeconds } = request.body as any;

    // Strict input validation
    if (!name || !triggerType || !communicationChannel || !templateId) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Missing parameters' } });
    }
    if (inactivityDurationMinutes <= 0 || minIntentScore < 0 || minIntentScore > 100 || cooldownSeconds < 0) {
      return reply.status(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid range limits' } });
    }

    const campaign = await withStoreContext(storeId, async (storeTrx: any) => {
      const [row] = await storeTrx('campaigns')
        .insert({
          store_id: storeId,
          name,
          status: 'paused', // Start paused
          trigger_type: triggerType,
          inactivity_duration_minutes: inactivityDurationMinutes,
          min_intent_score: minIntentScore,
          communication_channel: communicationChannel,
          template_id: templateId,
          cooldown_seconds: cooldownSeconds,
        })
        .returning('*');
      return row;
    });

    // Audit log - never log secrets, only safe campaign metadata
    await withAdminContext(async (adminTrx: any) => {
      await adminTrx('audit_logs').insert({
        organization_id: user.organizationId,
        actor_id: user.id,
        actor_email: user.email,
        action: 'campaign.created',
        resource_type: 'campaign',
        resource_id: campaign.id,
        metadata: { name: campaign.name, storeId, channel: communicationChannel },
      });
    }).catch(() => {}); // Non-blocking audit

    return reply.status(201).send({ data: campaign });
  });

  // PUT /api/v1/campaigns/:id
  fastify.put('/api/v1/campaigns/:id', { preHandler: [authenticateMerchant, authorizeRoles(['owner', 'admin'])] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as any;
    const storeId = user.activeStoreId;
    const { name, inactivityDurationMinutes, minIntentScore, templateId, cooldownSeconds } = request.body as any;

    if (inactivityDurationMinutes !== undefined && inactivityDurationMinutes <= 0) {
      return reply.status(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Inactivity duration must be positive' } });
    }
    if (minIntentScore !== undefined && (minIntentScore < 0 || minIntentScore > 100)) {
      return reply.status(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Intent score must be 0 to 100' } });
    }
    if (cooldownSeconds !== undefined && cooldownSeconds < 0) {
      return reply.status(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Cooldown must be positive' } });
    }

    const updated = await withStoreContext(storeId, async (storeTrx: any) => {
      const [row] = await storeTrx('campaigns')
        .where({ id, store_id: storeId })
        .update({
          name: name || undefined,
          inactivity_duration_minutes: inactivityDurationMinutes || undefined,
          min_intent_score: minIntentScore !== undefined ? minIntentScore : undefined,
          template_id: templateId || undefined,
          cooldown_seconds: cooldownSeconds !== undefined ? cooldownSeconds : undefined,
          updated_at: new Date(),
        })
        .returning('*');
      return row;
    });

    if (!updated) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }

    // Audit log
    await withAdminContext(async (adminTrx: any) => {
      await adminTrx('audit_logs').insert({
        organization_id: user.organizationId,
        actor_id: user.id,
        actor_email: user.email,
        action: 'campaign.updated',
        resource_type: 'campaign',
        resource_id: id,
        metadata: { storeId, updatedFields: Object.keys(request.body as any) },
      });
    }).catch(() => {});

    return reply.send({ data: updated });
  });

  // POST /api/v1/campaigns/:id/toggle (Pause / Resume)
  fastify.post('/api/v1/campaigns/:id/toggle', { preHandler: [authenticateMerchant, authorizeRoles(['owner', 'admin'])] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as any;
    const storeId = user.activeStoreId;

    const campaign = await withStoreContext(storeId, async (storeTrx: any) => {
      const row = await storeTrx('campaigns').where({ id, store_id: storeId }).first();
      if (!row) return null;

      const nextStatus = row.status === 'active' ? 'paused' : 'active';
      const [updated] = await storeTrx('campaigns')
        .where({ id })
        .update({ status: nextStatus, updated_at: new Date() })
        .returning('*');
      return updated;
    });

    if (!campaign) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }

    // Audit log
    await withAdminContext(async (adminTrx: any) => {
      await adminTrx('audit_logs').insert({
        organization_id: user.organizationId,
        actor_id: user.id,
        actor_email: user.email,
        action: 'campaign.toggled',
        resource_type: 'campaign',
        resource_id: id,
        metadata: { storeId, newStatus: campaign.status },
      });
    }).catch(() => {});

    return reply.send({ data: campaign });
  });

  // DELETE /api/v1/campaigns/:id (Soft-delete / Archive)
  fastify.delete('/api/v1/campaigns/:id', { preHandler: [authenticateMerchant, authorizeRoles(['owner', 'admin'])] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as any;
    const storeId = user.activeStoreId;

    const campaign = await withStoreContext(storeId, async (storeTrx: any) => {
      const [row] = await storeTrx('campaigns')
        .where({ id, store_id: storeId })
        .update({ deleted_at: new Date(), updated_at: new Date() })
        .returning('*');
      return row;
    });

    if (!campaign) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }

    // Audit log
    await withAdminContext(async (adminTrx: any) => {
      await adminTrx('audit_logs').insert({
        organization_id: user.organizationId,
        actor_id: user.id,
        actor_email: user.email,
        action: 'campaign.archived',
        resource_type: 'campaign',
        resource_id: id,
        metadata: { storeId, name: campaign.name },
      });
    }).catch(() => {});

    return reply.send({ data: { message: 'Campaign archived successfully' } });
  });

  // GET /api/v1/campaigns/:id/preview
  fastify.get('/api/v1/campaigns/:id/preview', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as any;
    const storeId = user.activeStoreId;

    const preview = await withStoreContext(storeId, async (storeTrx: any) => {
      const campaign = await storeTrx('campaigns').where({ id, store_id: storeId }).first();
      if (!campaign) return null;

      const integration = await storeTrx('integrations')
        .where({ store_id: storeId, provider: 'whatsapp', status: 'active' })
        .first();

      const shoppersCount = await storeTrx('shoppers')
        .where({ store_id: storeId })
        .andWhere('intent_score', '>=', campaign.min_intent_score)
        .count('id as count')
        .first();

      return {
        campaignName: campaign.name,
        whatsappConfigured: !!integration,
        intentThreshold: campaign.min_intent_score,
        estimatedMatchingShoppers: shoppersCount ? parseInt(shoppersCount.count as string, 10) : 0,
      };
    });

    if (!preview) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }
    return reply.send({ data: preview });
  });

  // --- WhatsApp Integration Setting Routes ---

  // GET /api/v1/integrations/whatsapp
  fastify.get('/api/v1/integrations/whatsapp', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;

    const integration = await withStoreContext(storeId, async (storeTrx: any) => {
      return await storeTrx('integrations').where({ store_id: storeId, provider: 'whatsapp' }).first();
    });

    if (!integration) {
      return reply.send({ data: null });
    }

    // Mask sensitive configurations to prevent secret leaks
    return reply.send({
      data: {
        id: integration.id,
        provider: 'whatsapp',
        status: integration.status,
        phoneNumberId: integration.configuration.phoneNumberId,
        isMock: integration.configuration.isMock,
        isConfigured: !!integration.configuration.accessTokenEncrypted,
      },
    });
  });

  // POST /api/v1/integrations/whatsapp
  fastify.post('/api/v1/integrations/whatsapp', { preHandler: [authenticateMerchant, authorizeRoles(['owner', 'admin'])] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;
    const { phoneNumberId, accessToken, isMock } = request.body as any;

    if (!phoneNumberId || !accessToken) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Missing parameters' } });
    }

    const encryptedToken = encryptPII(accessToken);

    const integration = await withStoreContext(storeId, async (storeTrx: any) => {
      const existing = await storeTrx('integrations').where({ store_id: storeId, provider: 'whatsapp' }).first();

      const configuration = {
        phoneNumberId,
        accessTokenEncrypted: encryptedToken,
        isMock: !!isMock,
      };

      if (existing) {
        const [updated] = await storeTrx('integrations')
          .where({ id: existing.id })
          .update({
            configuration,
            updated_at: new Date(),
          })
          .returning('*');
        return updated;
      } else {
        const [inserted] = await storeTrx('integrations')
          .insert({
            store_id: storeId,
            provider: 'whatsapp',
            configuration,
            status: 'active',
          })
          .returning('*');
        return inserted;
      }
    });

    // Audit log - NEVER log the access token
    await withAdminContext(async (adminTrx: any) => {
      await adminTrx('audit_logs').insert({
        organization_id: user.organizationId,
        actor_id: user.id,
        actor_email: user.email,
        action: 'whatsapp.configured',
        resource_type: 'integration',
        resource_id: integration.id,
        metadata: { phoneNumberId, storeId }, // accessToken intentionally excluded
      });
    }).catch(() => {});

    return reply.send({
      data: {
        id: integration.id,
        provider: 'whatsapp',
        status: integration.status,
        phoneNumberId: integration.configuration.phoneNumberId,
      },
    });
  });

  // POST /api/v1/integrations/whatsapp/toggle (Enable/Disable)
  fastify.post('/api/v1/integrations/whatsapp/toggle', { preHandler: [authenticateMerchant, authorizeRoles(['owner', 'admin'])] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;

    const integration = await withStoreContext(storeId, async (storeTrx: any) => {
      const existing = await storeTrx('integrations').where({ store_id: storeId, provider: 'whatsapp' }).first();
      if (!existing) return null;

      const nextStatus = existing.status === 'active' ? 'disabled' : 'active';
      const [updated] = await storeTrx('integrations')
        .where({ id: existing.id })
        .update({ status: nextStatus, updated_at: new Date() })
        .returning('*');
      return updated;
    });

    if (!integration) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Integration not found' } });
    }

    return reply.send({
      data: {
        id: integration.id,
        status: integration.status,
      },
    });
  });

  // --- API Key Management Routes ---

  // GET /api/v1/api-keys
  fastify.get('/api/v1/api-keys', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;

    const keys = await withStoreContext(storeId, async (storeTrx: any) => {
      return await storeTrx('api_keys')
        .where({ store_id: storeId })
        .select('id', 'key_prefix', 'name', 'status', 'expires_at', 'created_at');
    });
    return reply.send({ data: keys });
  });

  // POST /api/v1/api-keys
  fastify.post('/api/v1/api-keys', { preHandler: [authenticateMerchant, authorizeRoles(['owner', 'admin'])] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;
    const { name, expiresDays } = request.body as any;

    if (!name) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Missing key name' } });
    }

    // Generate prefix and raw key
    const rawKey = `rev_live_${crypto.randomBytes(24).toString('hex')}`;
    const keyPrefix = rawKey.substring(0, 8);
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const expiresAt = expiresDays ? new Date(Date.now() + expiresDays * 24 * 3600 * 1000) : null;

    const apiKey = await withStoreContext(storeId, async (storeTrx: any) => {
      const [row] = await storeTrx('api_keys')
        .insert({
          store_id: storeId,
          key_prefix: keyPrefix,
          key_hash: keyHash,
          name,
          status: 'active',
          expires_at: expiresAt,
        })
        .returning(['id', 'key_prefix', 'name', 'status', 'expires_at', 'created_at']);
      return row;
    });

    // Audit log - NEVER log the raw key, only the prefix
    await withAdminContext(async (adminTrx: any) => {
      await adminTrx('audit_logs').insert({
        organization_id: user.organizationId,
        actor_id: user.id,
        actor_email: user.email,
        action: 'api_key.created',
        resource_type: 'api_key',
        resource_id: apiKey.id,
        metadata: { name, keyPrefix, storeId }, // rawKey intentionally excluded
      });
    }).catch(() => {});

    // Return key in response exactly once - never stored again
    return reply.status(201).send({
      data: {
        ...apiKey,
        rawKey, // Exposed only once to the client
      },
    });
  });

  // DELETE /api/v1/api-keys/:id (Revoke API Key)
  fastify.delete('/api/v1/api-keys/:id', { preHandler: [authenticateMerchant, authorizeRoles(['owner', 'admin'])] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as any;
    const storeId = user.activeStoreId;

    const apiKey = await withStoreContext(storeId, async (storeTrx: any) => {
      const [row] = await storeTrx('api_keys')
        .where({ id, store_id: storeId })
        .update({
          status: 'revoked',
          revoked_at: new Date(),
          updated_at: new Date(),
        })
        .returning(['id', 'key_prefix', 'name', 'status']);
      return row;
    });

    if (!apiKey) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'API key not found' } });
    }

    // Audit log
    await withAdminContext(async (adminTrx: any) => {
      await adminTrx('audit_logs').insert({
        organization_id: user.organizationId,
        actor_id: user.id,
        actor_email: user.email,
        action: 'api_key.revoked',
        resource_type: 'api_key',
        resource_id: id,
        metadata: { storeId, keyPrefix: apiKey.key_prefix, name: apiKey.name },
      });
    }).catch(() => {});

    return reply.send({ data: { message: 'API key revoked successfully' } });
  });

  // --- Message Logs Route ---

  // GET /api/v1/messages
  fastify.get('/api/v1/messages', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;
    const { page = 1, limit = 50 } = request.query as any;

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const logs = await withStoreContext(storeId, async (storeTrx: any) => {
      return await storeTrx('message_logs')
        .where({ store_id: storeId })
        .orderBy('created_at', 'desc')
        .limit(parseInt(limit, 10))
        .offset(offset);
    });

    // Mask PII values if present
    const maskedLogs = logs.map((log: any) => ({
      id: log.id,
      campaignId: log.campaign_id,
      channel: log.channel,
      status: log.status,
      failureReason: log.failure_reason,
      sentAt: log.sent_at,
      deliveredAt: log.delivered_at,
      readAt: log.read_at,
      failedAt: log.failed_at,
      createdAt: log.created_at,
    }));

    return reply.send({ data: maskedLogs });
  });

  // --- Audit Logs Route ---

  // GET /api/v1/audit-logs
  fastify.get('/api/v1/audit-logs', { preHandler: [authenticateMerchant, authorizeRoles(['owner', 'admin'])] }, async (request, reply) => {
    const user = request.user!;
    const { page = 1, limit = 50 } = request.query as any;

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const logs = await withAdminContext(async (adminTrx: any) => {
      return await adminTrx('audit_logs')
        .where({ organization_id: user.organizationId })
        .orderBy('created_at', 'desc')
        .limit(parseInt(limit, 10))
        .offset(offset);
    });

    return reply.send({ data: logs });
  });

  // --- Analytics Overview & Funnel Routes ---

  // GET /api/v1/analytics/overview
  fastify.get('/api/v1/analytics/overview', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;

    const stats = await withStoreContext(storeId, async (storeTrx: any) => {
      const rows = await storeTrx('message_logs')
        .where({ store_id: storeId })
        .select('status')
        .count('id as count')
        .groupBy('status');

      const overview: Record<string, number> = {
        total: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
      };

      for (const row of rows) {
        const count = parseInt(row.count as string, 10);
        overview.total += count;
        if (row.status === 'sent') overview.sent = count;
        if (row.status === 'delivered') overview.delivered = count;
        if (row.status === 'read') overview.read = count;
        if (row.status === 'failed') overview.failed = count;
      }

      // Rates Calculations
      const deliveryRate = overview.total > 0 ? (overview.delivered + overview.read) / overview.total : 0;
      const readRate = overview.total > 0 ? overview.read / overview.total : 0;

      return {
        ...overview,
        deliveryRate: parseFloat(deliveryRate.toFixed(4)),
        readRate: parseFloat(readRate.toFixed(4)),
      };
    });

    return reply.send({ data: stats });
  });

  // GET /api/v1/analytics/intent
  fastify.get('/api/v1/analytics/intent', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;

    const intentSegments = await withStoreContext(storeId, async (storeTrx: any) => {
      // Use 'shoppers' table (not 'shopper_intent' which doesn't exist)
      const rows = await storeTrx('shoppers')
        .where({ store_id: storeId })
        .select('intent_segment')
        .count('id as count')
        .groupBy('intent_segment');

      const distribution = { low: 0, medium: 0, high: 0 };
      for (const row of rows) {
        if (row.intent_segment === 'low') distribution.low = parseInt(row.count as string, 10);
        if (row.intent_segment === 'medium') distribution.medium = parseInt(row.count as string, 10);
        if (row.intent_segment === 'high') distribution.high = parseInt(row.count as string, 10);
      }
      return distribution;
    });

    return reply.send({ data: intentSegments });
  });

  // GET /api/v1/analytics/campaigns - per-campaign message stats
  fastify.get('/api/v1/analytics/campaigns', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;

    const stats = await withStoreContext(storeId, async (storeTrx: any) => {
      const rows = await storeTrx('message_logs')
        .where({ 'message_logs.store_id': storeId })
        .join('campaigns', 'message_logs.campaign_id', 'campaigns.id')
        .select(
          'message_logs.campaign_id',
          'campaigns.name as campaign_name',
          'campaigns.status as campaign_status',
          'message_logs.status'
        )
        .count('message_logs.id as count')
        .groupBy('message_logs.campaign_id', 'campaigns.name', 'campaigns.status', 'message_logs.status');

      // Aggregate by campaign
      const campaignMap: Record<string, any> = {};
      for (const row of rows) {
        if (!campaignMap[row.campaign_id]) {
          campaignMap[row.campaign_id] = {
            campaignId: row.campaign_id,
            campaignName: row.campaign_name,
            campaignStatus: row.campaign_status,
            sent: 0, delivered: 0, read: 0, failed: 0, total: 0,
          };
        }
        const count = parseInt(row.count as string, 10);
        campaignMap[row.campaign_id].total += count;
        if (row.status === 'sent') campaignMap[row.campaign_id].sent = count;
        if (row.status === 'delivered') campaignMap[row.campaign_id].delivered = count;
        if (row.status === 'read') campaignMap[row.campaign_id].read = count;
        if (row.status === 'failed') campaignMap[row.campaign_id].failed = count;
      }

      return Object.values(campaignMap);
    });

    return reply.send({ data: stats });
  });

  // GET /api/v1/analytics/funnel
  fastify.get('/api/v1/analytics/funnel', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;

    try {
      const chClient = getClickHouseClient();
      // Use parameterized query to prevent SQL injection
      const query = `
        SELECT
          uniqExact(shopper_id) as stage_unique_shoppers,
          countIf(event_type = 'page_view') as stage_page_views,
          countIf(event_type = 'product_view') as stage_product_views,
          countIf(event_type = 'cart_add') as stage_cart_adds,
          countIf(event_type = 'purchase') as stage_purchases
        FROM events_analytics
        WHERE tenant_id = {storeId:UUID}
      `;

      const result = await chClient.query({
        query,
        query_params: { storeId },
        format: 'JSONEachRow',
      });

      const dataset = await result.json();
      return reply.send({ data: dataset[0] || {
        stage_unique_shoppers: 0,
        stage_page_views: 0,
        stage_product_views: 0,
        stage_cart_adds: 0,
        stage_purchases: 0,
      }});
    } catch (err) {
      fastify.log.error(err, 'Failed to fetch ClickHouse analytics');
      // Graceful fallback to zero aggregates if ClickHouse is unavailable
      return reply.send({ data: {
        stage_unique_shoppers: 0,
        stage_page_views: 0,
        stage_product_views: 0,
        stage_cart_adds: 0,
        stage_purchases: 0,
      }});
    }
  });

  // --- Phase 11: Recommendation Engine & Product Catalog Routes ---

  const recModel = new HybridRecommendationModel();

  // GET /api/v1/recommendations
  fastify.get('/api/v1/recommendations', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;
    const { shopperId, sessionId, strategy, productId, category, limit, skipCache } = request.query as any;

    const parsedLimit = limit ? parseInt(limit, 10) : 10;
    if (isNaN(parsedLimit) || parsedLimit <= 0) {
      return reply.status(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Limit must be a positive integer' } });
    }

    try {
      const response = await recModel.recommend({
        storeId,
        shopperId,
        sessionId,
        strategy,
        productId,
        category,
        limit: Math.min(parsedLimit, 50),
        skipCache: skipCache === 'true',
      });

      return reply.send({ data: response });
    } catch (err) {
      fastify.log.error(err, 'Recommendation generation failed');
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate recommendations' } });
    }
  });

  // POST /api/v1/products (Product Ingestion for Merchants)
  fastify.post('/api/v1/products', { preHandler: [authenticateMerchant, authorizeRoles(['owner', 'admin'])] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;
    const { sku, name, categories, brand, price, status, metadata } = request.body as any;

    if (!sku || !name || price === undefined) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Missing sku, name, or price' } });
    }

    const numericPrice = parseFloat(price);
    if (isNaN(numericPrice) || numericPrice < 0) {
      return reply.status(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Price must be non-negative' } });
    }

    const product = await upsertProduct(storeId, {
      sku,
      name,
      categories: Array.isArray(categories) ? categories : [],
      brand: brand || undefined,
      price: numericPrice,
      status: status || 'active',
      metadata: metadata || {},
    });

    return reply.status(201).send({ data: product });
  });

  // GET /api/v1/products (List Store Products)
  fastify.get('/api/v1/products', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;
    const { category, brand, limit } = request.query as any;

    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    const products = await getActiveProducts(storeId, {
      category,
      brand,
      limit: Math.min(parsedLimit, 100),
    });

    return reply.send({ data: products });
  });

  // POST /api/v1/recommendations/events (Track Impressions, Clicks, Conversions)
  fastify.post('/api/v1/recommendations/events', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;
    const { shopperId, productId, eventType, strategy, recommendationId } = request.body as any;

    if (!productId || !eventType || !strategy) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Missing productId, eventType, or strategy' } });
    }

    const validEventTypes = ['recommendation_impression', 'recommendation_click', 'recommendation_conversion'];
    if (!validEventTypes.includes(eventType)) {
      return reply.status(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid eventType' } });
    }

    await withStoreContext(storeId, async (trx: any) => {
      await trx('recommendation_events').insert({
        store_id: storeId,
        shopper_id: shopperId || null,
        product_id: productId,
        event_type: eventType,
        strategy: strategy,
        recommendation_id: recommendationId || null,
      });
    });

    return reply.status(201).send({ data: { tracked: true } });
  });

  // GET /api/v1/analytics/recommendations (Merchant Analytics for Recommendations)
  fastify.get('/api/v1/analytics/recommendations', { preHandler: [authenticateMerchant] }, async (request, reply) => {
    const user = request.user!;
    const storeId = user.activeStoreId;

    const analytics = await withStoreContext(storeId, async (storeTrx: any) => {
      const rows = await storeTrx('recommendation_events')
        .where({ store_id: storeId })
        .select('strategy', 'event_type')
        .count('id as count')
        .groupBy('strategy', 'event_type');

      const strategyMap: Record<string, { strategy: string; impressions: number; clicks: number; conversions: number; ctr: number; conversionRate: number }> = {};

      for (const row of rows) {
        if (!strategyMap[row.strategy]) {
          strategyMap[row.strategy] = {
            strategy: row.strategy,
            impressions: 0,
            clicks: 0,
            conversions: 0,
            ctr: 0,
            conversionRate: 0,
          };
        }

        const count = parseInt(row.count as string, 10);
        if (row.event_type === 'recommendation_impression') strategyMap[row.strategy].impressions = count;
        if (row.event_type === 'recommendation_click') strategyMap[row.strategy].clicks = count;
        if (row.event_type === 'recommendation_conversion') strategyMap[row.strategy].conversions = count;
      }

      for (const key in strategyMap) {
        const item = strategyMap[key];
        item.ctr = item.impressions > 0 ? parseFloat((item.clicks / item.impressions).toFixed(4)) : 0;
        item.conversionRate = item.clicks > 0 ? parseFloat((item.conversions / item.clicks).toFixed(4)) : 0;
      }

      return Object.values(strategyMap);
    });

    return reply.send({ data: analytics });
  });
}
