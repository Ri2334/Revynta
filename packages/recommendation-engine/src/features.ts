import {
  getSessionState,
  getTopAffinities,
  isPurchaseSuppressed,
  withStoreContext,
} from '@revynta/database';
import { ShopperFeatures } from './types.js';

export async function extractShopperFeatures(
  storeId: string,
  shopperId?: string,
  sessionId?: string
): Promise<ShopperFeatures> {
  let isSuppressed = false;
  let intentScore = 0;
  let intentSegment = 'low';
  let personalizationConsent = true; // Default to true unless explicitly denied

  // 1. Resolve purchase suppression and intent score from DB if shopperId provided
  if (shopperId) {
    isSuppressed = await isPurchaseSuppressed(storeId, shopperId);

    await withStoreContext(storeId, async (trx: any) => {
      // Check intent score
      const intentRow = await trx('shopper_intent')
        .where({ store_id: storeId, shopper_id: shopperId })
        .first();
      if (intentRow) {
        intentScore = intentRow.intent_score;
        intentSegment = intentRow.intent_segment;
      }

      // Check personalization consent (Phase 5 integration)
      const consentRow = await trx('consent_records')
        .where({ store_id: storeId, shopper_id: shopperId, purpose: 'personalization' })
        .first();
      if (consentRow && consentRow.status === 'denied') {
        personalizationConsent = false;
      }
    });
  }

  // 2. Fetch top product & category affinities from Redis
  let topProductAffinities: Array<{ member: string; score: number }> = [];
  let topCategoryAffinities: Array<{ member: string; score: number }> = [];

  if (personalizationConsent) {
    topProductAffinities = await getTopAffinities(storeId, 'product', 10);
    topCategoryAffinities = await getTopAffinities(storeId, 'category', 10);
  }

  // 3. Fetch recent viewed products from Redis session if sessionId provided
  const recentViewedProductIds: string[] = [];
  const recentCategories: string[] = [];

  if (sessionId) {
    const sessionData = await getSessionState(storeId, sessionId);
    if (sessionData) {
      if (sessionData.last_product_id) {
        recentViewedProductIds.push(sessionData.last_product_id);
      }
      if (sessionData.last_categories) {
        try {
          const cats = JSON.parse(sessionData.last_categories);
          if (Array.isArray(cats)) recentCategories.push(...cats);
        } catch {
          // Ignore JSON parse error
        }
      }
    }
  }

  return {
    storeId,
    shopperId,
    sessionId,
    intentScore,
    intentSegment,
    isPurchased: isSuppressed,
    topProductAffinities,
    topCategoryAffinities,
    recentViewedProductIds,
    recentCategories,
    personalizationConsent,
  };
}
