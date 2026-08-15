import { describe, it, expect } from 'vitest';
import { HeuristicIntentModel } from '../src/engine.js';
import { SessionState } from '../src/types.js';

describe('Phase 7 - Intent Score Simulation Matrix (Scenarios A through F)', () => {
  const model = new HeuristicIntentModel();
  const now = new Date().toISOString();

  const createSession = (signals: Array<{ type: string; weight: number; timestamp?: string }>): SessionState => ({
    tenantId: 'sim-store',
    storeId: 'sim-store',
    sessionId: 'sim-session',
    shopperId: 'sim-shopper',
    lastActivityAt: now,
    lastEventTimestamp: Date.now(),
    eventCount: signals.length,
    pageViews: 1,
    productViews: signals.filter((s) => s.type.includes('product')).length,
    cartAdds: signals.filter((s) => s.type === 'cart_add').length,
    checkoutInitiations: signals.filter((s) => s.type === 'checkout_init').length,
    purchaseCompleted: false,
    viewedProducts: {},
    viewedCategories: {},
    signals: signals.map((s) => ({
      type: s.type,
      weight: s.weight,
      timestamp: s.timestamp || now,
    })),
  });

  it('Scenario A: 1 product view', () => {
    const session = createSession([{ type: 'product_view', weight: 5 }]);
    const res = model.calculateIntent(session);
    console.log(`Scenario A (1 product view): Score = ${res.score}, Segment = ${res.segment}`);
    expect(res.score).toBe(5);
    expect(res.segment).toBe('low');
  });

  it('Scenario B: 3 product views (same product repeat views)', () => {
    const session = createSession([
      { type: 'product_view', weight: 5 },
      { type: 'repeat_product_view', weight: 10 },
      { type: 'repeat_product_view', weight: 10 },
    ]);
    const res = model.calculateIntent(session);
    console.log(`Scenario B (3 product views): Score = ${res.score}, Segment = ${res.segment}`);
    expect(res.score).toBe(25);
    expect(res.segment).toBe('low');
  });

  it('Scenario C: 5 different product views', () => {
    const session = createSession([
      { type: 'product_view', weight: 5 },
      { type: 'product_view', weight: 5 },
      { type: 'product_view', weight: 5 },
      { type: 'product_view', weight: 5 },
      { type: 'product_view', weight: 5 },
    ]);
    const res = model.calculateIntent(session);
    console.log(`Scenario C (5 different products): Score = ${res.score}, Segment = ${res.segment}`);
    expect(res.score).toBe(25);
    expect(res.segment).toBe('low');
  });

  it('Scenario D: 3 repeat product views + search', () => {
    const session = createSession([
      { type: 'product_view', weight: 5 },
      { type: 'repeat_product_view', weight: 10 },
      { type: 'repeat_product_view', weight: 10 },
      { type: 'search', weight: 8 },
    ]);
    const res = model.calculateIntent(session);
    console.log(`Scenario D (3 repeat views + search): Score = ${res.score}, Segment = ${res.segment}`);
    expect(res.score).toBe(33);
    expect(res.segment).toBe('medium');
  });

  it('Scenario E: High-intent behavior with cart add', () => {
    const session = createSession([
      { type: 'product_view', weight: 5 },
      { type: 'repeat_product_view', weight: 10 },
      { type: 'search', weight: 8 },
      { type: 'cart_add', weight: 25 },
    ]);
    const res = model.calculateIntent(session);
    console.log(`Scenario E (High-intent with cart): Score = ${res.score}, Segment = ${res.segment}`);
    expect(res.score).toBe(48);
    expect(res.segment).toBe('medium');
  });

  it('Scenario F: High-intent checkout initiation', () => {
    const session = createSession([
      { type: 'product_view', weight: 5 },
      { type: 'repeat_product_view', weight: 10 },
      { type: 'cart_add', weight: 25 },
      { type: 'checkout_init', weight: 50 },
    ]);
    const res = model.calculateIntent(session);
    console.log(`Scenario F (Checkout initiation): Score = ${res.score}, Segment = ${res.segment}`);
    expect(res.score).toBe(90);
    expect(res.segment).toBe('high');
  });
});
