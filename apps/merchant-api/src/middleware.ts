import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from './auth-utils.js';
import { withAdminContext } from '@revynta/database';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      email: string;
      organizationId: string;
      role: string;
      activeStoreId: string;
      accessibleStoreIds: string[];
    };
  }
}

export async function authenticateMerchant(request: FastifyRequest, reply: FastifyReply) {
  // Extract token from Cookie or Authorization header
  let token = request.cookies.revynta_session;
  
  if (!token) {
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
  }

  if (!token) {
    return reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
    });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired session' }
    });
  }

  // Resolve user memberships and stores bypassing RLS
  const resolved = await withAdminContext(async (adminTrx: any) => {
    const userRow = await adminTrx('users').where({ id: payload.userId }).first();
    if (!userRow) return null;

    const membership = await adminTrx('memberships').where({ user_id: payload.userId }).first();
    if (!membership) return null;

    const stores = await adminTrx('stores').where({ organization_id: membership.organization_id }).select('id');
    const storeIds = stores.map((s: any) => s.id);

    return {
      userRow,
      membership,
      storeIds,
    };
  });

  if (!resolved) {
    return reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Membership not configured' }
    });
  }

  const { userRow, membership, storeIds } = resolved;

  // Resolve target store ID (from header, query, or body)
  const headerStoreId = request.headers['x-store-id'] as string;
  const queryStoreId = (request.query as any).storeId as string;
  const bodyStoreId = (request.body as any)?.storeId as string;
  
  let targetStoreId = headerStoreId || queryStoreId || bodyStoreId || storeIds[0];

  if (!targetStoreId && storeIds.length > 0) {
    targetStoreId = storeIds[0];
  }

  // IDOR check: Verify store belongs to the user's organization
  if (targetStoreId && !storeIds.includes(targetStoreId)) {
    return reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Access to store is unauthorized' }
    });
  }

  request.user = {
    id: userRow.id,
    email: userRow.email,
    organizationId: membership.organization_id,
    role: membership.role,
    activeStoreId: targetStoreId,
    accessibleStoreIds: storeIds,
  };
}

export function authorizeRoles(allowedRoles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user || !allowedRoles.includes(request.user.role)) {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Insufficient role permissions' }
      });
    }
  };
}
