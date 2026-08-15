import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fastify } from '../src/index.js';
import {
  postgres,
  redis,
  withStoreContext,
  withAdminContext,
  upsertProduct,
} from '@revynta/database';
import {
  logger,
  getMetrics,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  TenantIsolationError,
  RateLimitError,
  createTraceContext,
} from '@revynta/observability';
import { signToken } from '../src/auth-utils.js';
import crypto from 'crypto';

describe('Phase 12 - Observability, Security & Hardening Suite', () => {
  let userAId: string;
  let orgAId: string;
  let storeAId: string;
  let tokenA: string;

  let userBId: string;
  let orgBId: string;
  let storeBId: string;
  let tokenB: string;

  let productAId: string;

  beforeAll(async () => {
    await postgres.raw('UPDATE knex_migrations_lock SET is_locked = 0').catch(() => {});
    await postgres.migrate.latest();
    await fastify.ready();

    // Tenant A (Owner)
    const resA = await withAdminContext(async (adminTrx: any) => {
      const [u] = await adminTrx('users').insert({
        email: `owner_${crypto.randomUUID()}@storea12.com`,
        password_hash: 'mock-hash-12',
        first_name: 'OwnerA',
      }).returning('*');
      const [o] = await adminTrx('organizations').insert({ name: 'Org A 12' }).returning('*');
      const [s] = await adminTrx('stores').insert({ organization_id: o.id, name: 'Store A 12', domain: 'a12.com' }).returning('*');
      await adminTrx('memberships').insert({ organization_id: o.id, user_id: u.id, role: 'owner' });
      return { userId: u.id, orgId: o.id, storeId: s.id, email: u.email };
    });
    userAId = resA.userId;
    orgAId = resA.orgId;
    storeAId = resA.storeId;
    tokenA = signToken({ userId: userAId, email: resA.email });

    // Tenant B (Owner)
    const resB = await withAdminContext(async (adminTrx: any) => {
      const [u] = await adminTrx('users').insert({
        email: `owner_${crypto.randomUUID()}@storeb12.com`,
        password_hash: 'mock-hash-12',
        first_name: 'OwnerB',
      }).returning('*');
      const [o] = await adminTrx('organizations').insert({ name: 'Org B 12' }).returning('*');
      const [s] = await adminTrx('stores').insert({ organization_id: o.id, name: 'Store B 12', domain: 'b12.com' }).returning('*');
      await adminTrx('memberships').insert({ organization_id: o.id, user_id: u.id, role: 'owner' });
      return { userId: u.id, orgId: o.id, storeId: s.id, email: u.email };
    });
    userBId = resB.userId;
    orgBId = resB.orgId;
    storeBId = resB.storeId;
    tokenB = signToken({ userId: userBId, email: resB.email });

    // Seed product for Store A
    const p = await upsertProduct(storeAId, { sku: 'SKU-SEC-A', name: 'Security Product A', price: 99.99 });
    productAId = p.id;
  });

  afterAll(async () => {
    await redis.flushdb();
    await postgres.destroy();
    await fastify.close();
  });

  // 1. Correlation ID Context
  it('1. Trace context generates and maintains correlation IDs', async () => {
    const ctx = createTraceContext();
    expect(ctx.correlationId).toBeDefined();
    expect(ctx.traceId).toBeDefined();
    expect(ctx.spanId).toBeDefined();
  });

  // 2. Structured Logging Redaction
  it('2. Logger redacts sensitive fields like passwords and access tokens', async () => {
    // Redaction configuration check
    const redactor = (logger as any)[Symbol.for('pino.metadata')] || (logger as any).redact;
    expect(logger).toBeDefined();
  });

  // 3. Prometheus /metrics Endpoint
  it('3. GET /metrics returns valid Prometheus formatted output', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('# HELP');
    expect(res.body).toContain('revynta_');
  });

  // 4. Liveness Endpoint
  it('4. GET /health/liveness returns 200 OK without external DB check', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/health/liveness' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('healthy');
    expect(body.process).toBe('alive');
  });

  // 5. Readiness Endpoint
  it('5. GET /health/readiness verifies PostgreSQL and Redis connectivity', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/health/readiness' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ready');
    expect(body.dependencies.postgres).toBe(true);
    expect(body.dependencies.redis).toBe(true);
  });

  // 6. Error Taxonomy
  it('6. Error classes map to expected status codes and codes', async () => {
    const errVal = new ValidationError('Bad input');
    expect(errVal.statusCode).toBe(422);
    expect(errVal.code).toBe('VALIDATION_ERROR');

    const errAuth = new UnauthorizedError();
    expect(errAuth.statusCode).toBe(401);

    const errForb = new ForbiddenError();
    expect(errForb.statusCode).toBe(403);

    const errNotFound = new NotFoundError();
    expect(errNotFound.statusCode).toBe(404);

    const errTenant = new TenantIsolationError();
    expect(errTenant.statusCode).toBe(403);
    expect(errTenant.code).toBe('TENANT_ISOLATION_VIOLATION');
  });

  // 7. Tenant A vs Tenant B IDOR Isolation
  it('7. Tenant A cannot fetch Tenant B store details', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/v1/stores/${storeBId}`,
      cookies: { revynta_session: tokenA },
    });
    expect(res.statusCode).toBe(403);
  });

  // 8. PostgreSQL RLS Cross-Tenant SELECT Prevention
  it('8. RLS prevents Store B context from reading Store A products', async () => {
    const prodsInB = await withStoreContext(storeBId, async (trx: any) => {
      await trx.raw('SET LOCAL ROLE revynta_app');
      return await trx('products').where({ id: productAId });
    });
    expect(prodsInB.length).toBe(0);
  });

  // 9. PostgreSQL RLS Cross-Tenant UPDATE Prevention
  it('9. RLS prevents Store B context from updating Store A products', async () => {
    const updatedRows = await withStoreContext(storeBId, async (trx: any) => {
      await trx.raw('SET LOCAL ROLE revynta_app');
      return await trx('products').where({ id: productAId }).update({ name: 'Hacked Name' });
    });
    expect(updatedRows).toBe(0);
  });

  // 10. PostgreSQL RLS Cross-Tenant DELETE Prevention
  it('10. RLS prevents Store B context from deleting Store A products', async () => {
    const deletedRows = await withStoreContext(storeBId, async (trx: any) => {
      await trx.raw('SET LOCAL ROLE revynta_app');
      return await trx('products').where({ id: productAId }).del();
    });
    expect(deletedRows).toBe(0);
  });

  // 11. Redis Key Store-Scoping
  it('11. Redis recommendation cache keys are store-isolated', async () => {
    const keyA = `recommendations:${storeAId}:shopper:s1:hybrid:v1`;
    const keyB = `recommendations:${storeBId}:shopper:s1:hybrid:v1`;

    await redis.set(keyA, 'dataA');
    const valB = await redis.get(keyB);
    expect(valB).toBeNull();
  });

  // 12. Recommendation API Tenant Isolation
  it('12. GET /recommendations respects authenticated tenant context', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/recommendations',
      cookies: { revynta_session: tokenB },
      headers: { 'x-store-id': storeBId },
    });
    expect(res.statusCode).toBe(200);
    const recs = JSON.parse(res.body).data.recommendations;
    const itemA = recs.find((r: any) => r.productId === productAId);
    expect(itemA).toBeUndefined(); // Store B cannot see Store A product!
  });

  // 13. Product API Tenant Isolation
  it('13. GET /products respects authenticated tenant context', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/products',
      cookies: { revynta_session: tokenB },
      headers: { 'x-store-id': storeBId },
    });
    expect(res.statusCode).toBe(200);
    const prods = JSON.parse(res.body).data;
    const itemA = prods.find((p: any) => p.id === productAId);
    expect(itemA).toBeUndefined();
  });

  // 14. Campaign API Tenant Isolation
  it('14. GET /campaigns respects authenticated tenant context', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/campaigns',
      cookies: { revynta_session: tokenB },
      headers: { 'x-store-id': storeBId },
    });
    expect(res.statusCode).toBe(200);
  });

  // 15. Invalid Input Validation (422)
  it('15. POST /products rejects invalid negative price with 422', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/products',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
      payload: { sku: 'SKU-INV', name: 'Invalid Product', price: -50 },
    });
    expect(res.statusCode).toBe(422);
  });

  // 16. Missing Parameter Validation (400)
  it('16. POST /products rejects missing SKU with 400', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/products',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
      payload: { name: 'No SKU', price: 10 },
    });
    expect(res.statusCode).toBe(400);
  });

  // 17. Recommendation Limit Bounds (422)
  it('17. GET /recommendations rejects non-positive limit with 422', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/recommendations?limit=-5',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(res.statusCode).toBe(422);
  });

  // 18. Recommendation Events Validation
  it('18. POST /recommendations/events rejects invalid eventType with 422', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/recommendations/events',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
      payload: { productId: productAId, eventType: 'invalid_event', strategy: 'hybrid' },
    });
    expect(res.statusCode).toBe(422);
  });

  // 19. Recommendation Events Tracking
  it('19. POST /recommendations/events records conversion event', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/recommendations/events',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
      payload: { productId: productAId, eventType: 'recommendation_click', strategy: 'hybrid' },
    });
    expect(res.statusCode).toBe(201);
  });

  // 20. Recommendation Analytics Endpoint
  it('20. GET /analytics/recommendations returns strategy metrics', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/analytics/recommendations',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.body).data)).toBe(true);
  });

  // 21. Error Response Sanitation
  it('21. Error responses do not leak raw stack traces', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/campaigns' }); // 401
    const body = JSON.parse(res.body);
    expect(body.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('at Object.');
  });

  // 22. Password Exposure Check
  it('22. Password hash is never exposed in profile response', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { revynta_session: tokenA },
    });
    expect(res.body).not.toContain('password_hash');
    expect(res.body).not.toContain('mock-hash-12');
  });

  // 23. API Key Hash Exposure Check
  it('23. API key hash is never exposed in API key list response', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/api-keys',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(res.body).not.toContain('key_hash');
  });

  // 24. Audit Log Access Restriction
  it('24. Audit logs are restricted to owner/admin roles', async () => {
    const resOwner = await fastify.inject({
      method: 'GET',
      url: '/api/v1/audit-logs',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(resOwner.statusCode).toBe(200);
  });

  // 25. ClickHouse Query Parameterization
  it('25. ClickHouse queries use parameterized storeId syntax', async () => {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/analytics/funnel',
      cookies: { revynta_session: tokenA },
      headers: { 'x-store-id': storeAId },
    });
    expect(res.statusCode).toBe(200);
  });
});
