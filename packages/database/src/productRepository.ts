import { withStoreContext } from './postgres.js';

export interface ProductInput {
  sku: string;
  name: string;
  categories: string[];
  brand?: string;
  price: number;
  status?: 'active' | 'inactive' | 'out_of_stock';
  metadata?: Record<string, any>;
}

export interface ProductRecord {
  id: string;
  store_id: string;
  sku: string;
  name: string;
  categories: string[];
  brand: string | null;
  price: number;
  status: 'active' | 'inactive' | 'out_of_stock';
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * Upserts a product into the tenant product catalog
 */
export async function upsertProduct(storeId: string, input: ProductInput): Promise<ProductRecord> {
  return await withStoreContext(storeId, async (trx: any) => {
    const existing = await trx('products')
      .where({ store_id: storeId, sku: input.sku })
      .first();

    const payload = {
      store_id: storeId,
      sku: input.sku,
      name: input.name,
      categories: JSON.stringify(input.categories || []),
      brand: input.brand || null,
      price: input.price,
      status: input.status || 'active',
      metadata: JSON.stringify(input.metadata || {}),
      updated_at: new Date(),
    };

    if (existing) {
      const [updated] = await trx('products')
        .where({ id: existing.id })
        .update(payload)
        .returning('*');
      return parseProductRecord(updated);
    } else {
      const [inserted] = await trx('products')
        .insert({
          ...payload,
          deleted_at: null,
        })
        .returning('*');
      return parseProductRecord(inserted);
    }
  });
}

/**
 * Retrieves a product by ID within store context
 */
export async function getProductById(storeId: string, productId: string): Promise<ProductRecord | null> {
  return await withStoreContext(storeId, async (trx: any) => {
    const row = await trx('products')
      .where({ store_id: storeId, id: productId })
      .whereNull('deleted_at')
      .first();

    return row ? parseProductRecord(row) : null;
  });
}

/**
 * Retrieves products by IDs within store context
 */
export async function getProductsByIds(storeId: string, productIds: string[]): Promise<ProductRecord[]> {
  if (!productIds || productIds.length === 0) return [];
  return await withStoreContext(storeId, async (trx: any) => {
    const rows = await trx('products')
      .where({ store_id: storeId })
      .whereIn('id', productIds)
      .whereNull('deleted_at');

    return rows.map(parseProductRecord);
  });
}

/**
 * Retrieves active products for a store with optional category filter
 */
export async function getActiveProducts(
  storeId: string,
  options?: { category?: string; brand?: string; limit?: number }
): Promise<ProductRecord[]> {
  return await withStoreContext(storeId, async (trx: any) => {
    let query = trx('products')
      .where({ store_id: storeId, status: 'active' })
      .whereNull('deleted_at');

    if (options?.brand) {
      query = query.where({ brand: options.brand });
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query;
    let results = rows.map(parseProductRecord);

    if (options?.category) {
      results = results.filter((p: ProductRecord) =>
        p.categories.map((c) => c.toLowerCase()).includes(options.category!.toLowerCase())
      );
    }

    return results;
  });
}

/**
 * Logs recommendation generation metadata for analytics and evaluation
 */
export async function logRecommendationRun(
  storeId: string,
  data: {
    shopperId?: string;
    sessionId?: string;
    strategy: string;
    modelVersion: string;
    recommendedProducts: any[];
    metadata?: Record<string, any>;
  }
): Promise<void> {
  await withStoreContext(storeId, async (trx: any) => {
    await trx('recommendation_logs').insert({
      store_id: storeId,
      shopper_id: data.shopperId || null,
      session_id: data.sessionId || null,
      strategy: data.strategy,
      model_version: data.modelVersion,
      recommended_products: JSON.stringify(data.recommendedProducts),
      metadata: JSON.stringify(data.metadata || {}),
    });
  });
}

/**
 * Parses raw Knex product row into strongly-typed ProductRecord
 */
function parseProductRecord(row: any): ProductRecord {
  return {
    ...row,
    price: parseFloat(row.price),
    categories: typeof row.categories === 'string' ? JSON.parse(row.categories) : row.categories || [],
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {},
  };
}
