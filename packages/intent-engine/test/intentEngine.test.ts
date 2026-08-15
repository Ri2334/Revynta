import { describe, it, expect } from 'vitest';
import { HeuristicIntentModel } from '../src/engine.js';
import { SessionState } from '../src/types.js';
import { EnrichedEvent } from '@revynta/shared-types';

describe('Phase 7 - HeuristicIntentModel Unit Tests', () => {
  const model = new HeuristicIntentModel();

  const createMockSession = (overrides?: Partial<SessionState>): SessionState => ({
    tenantId: 'tenant-123',
    storeId: 'tenant-123',
    sessionId: 'session-456',
    shopperId: 'shopper-789',
    lastActivityAt: new Date().toISOString(),
    lastEventTimestamp: Date.now(),
    eventCount: 1,
    pageViews: 1,
    productViews: 0,
    cartAdds: 0,
    checkoutInitiations: 0,
    purchaseCompleted: false,
    viewedProducts: {},
    viewedCategories: {},
    signals: [],
    ...overrides,
  });

  const createMockEvent = (eventType: string, overrides?: Partial<EnrichedEvent>): EnrichedEvent => ({
    eventTime: new Date().toISOString(),
    eventId: `evt-${Math.random()}`,
    tenantId: 'tenant-123',
    sessionId: 'session-456',
    shopperId: 'shopper-789',
    eventType: eventType as any,
    sdkVersion: '1.0.0',
    pageUrl: 'https://example.com/product/1',
    ...overrides,
  });

  it('calculates low intent score for initial single page view', () => {
    const session = createMockSession();
    const event = createMockEvent('page_view');

    const result = model.calculateIntent(session, event);
    expect(result.score).toBe(1);
    expect(result.segment).toBe('low');
    expect(result.modelVersion).toBe('v1');
    expect(result.explanations.length).toBe(1);
    expect(result.explanations[0].type).toBe('page_view');
  });

  it('calculates medium intent score for multiple product views and search', () => {
    const session = createMockSession({
      signals: [
        { type: 'product_view', weight: 5, timestamp: new Date().toISOString() },
        { type: 'repeat_product_view', weight: 10, timestamp: new Date().toISOString() },
        { type: 'search', weight: 8, timestamp: new Date().toISOString() },
        { type: 'filter', weight: 6, timestamp: new Date().toISOString() },
      ],
    });
    const event = createMockEvent('product_view', { productId: 'prod-99' });

    const result = model.calculateIntent(session, event);
    expect(result.score).toBeGreaterThanOrEqual(30);
    expect(result.segment).toBe('medium');
  });

  it('calculates high intent score for checkout initiation and cart add', () => {
    const session = createMockSession({
      signals: [
        { type: 'product_view', weight: 5, timestamp: new Date().toISOString() },
        { type: 'cart_add', weight: 25, timestamp: new Date().toISOString() },
        { type: 'checkout_init', weight: 50, timestamp: new Date().toISOString() },
      ],
    });

    const result = model.calculateIntent(session);
    expect(result.score).toBe(80);
    expect(result.segment).toBe('high');
    expect(result.explanations.length).toBe(3);
    expect(result.explanations[0].type).toBe('checkout_init');
  });

  it('applies recency exponential decay for older signals', () => {
    const now = Date.now();
    const fortyEightHoursAgo = new Date(now - 48 * 60 * 60 * 1000).toISOString();

    const sessionRecent = createMockSession({
      signals: [{ type: 'cart_add', weight: 25, timestamp: new Date().toISOString() }],
    });
    const sessionOld = createMockSession({
      signals: [{ type: 'cart_add', weight: 25, timestamp: fortyEightHoursAgo }],
    });

    const recentResult = model.calculateIntent(sessionRecent);
    const oldResult = model.calculateIntent(sessionOld);

    expect(recentResult.score).toBe(25);
    // After 48 hours (1 half life), weight decays from 25 to approx 12.5 (13)
    expect(oldResult.score).toBe(13);
  });

  it('suppresses intent score to 0 when purchase is completed', () => {
    const session = createMockSession({
      purchaseCompleted: true,
      signals: [
        { type: 'cart_add', weight: 25, timestamp: new Date().toISOString() },
        { type: 'checkout_init', weight: 50, timestamp: new Date().toISOString() },
      ],
    });

    const result = model.calculateIntent(session);
    expect(result.score).toBe(0);
    expect(result.segment).toBe('low');
    expect(result.isPurchased).toBe(true);
    expect(result.explanations.length).toBe(0);
  });

  it('returns top 5 explanations ordered by decayed weight impact', () => {
    const now = new Date().toISOString();
    const session = createMockSession({
      signals: [
        { type: 'page_view', weight: 1, timestamp: now },
        { type: 'product_view', weight: 5, timestamp: now },
        { type: 'category_view', weight: 3, timestamp: now },
        { type: 'search', weight: 8, timestamp: now },
        { type: 'wishlist', weight: 15, timestamp: now },
        { type: 'cart_add', weight: 25, timestamp: now },
        { type: 'checkout_init', weight: 50, timestamp: now },
      ],
    });

    const result = model.calculateIntent(session);
    expect(result.explanations.length).toBe(5);
    expect(result.explanations[0].type).toBe('checkout_init');
    expect(result.explanations[1].type).toBe('cart_add');
    expect(result.explanations[2].type).toBe('wishlist');
    expect(result.explanations[3].type).toBe('search');
    expect(result.explanations[4].type).toBe('product_view');
  });
});
