import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RevyntaTracker } from '../src/tracker';

// Explicitly mock localStorage and sessionStorage for test isolation
const createMockStorage = () => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value.toString();
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] || null),
  };
};

const mockLocalStorage = createMockStorage();
const mockSessionStorage = createMockStorage();

globalThis.localStorage = mockLocalStorage as any;
globalThis.sessionStorage = mockSessionStorage as any;

// Mock window and document globally
globalThis.window = {
  addEventListener: vi.fn(),
  location: { href: 'https://testmerchant.com/products/shirt' }
} as any;

globalThis.document = {
  addEventListener: vi.fn(),
  referrer: 'https://google.com',
  querySelectorAll: vi.fn().mockReturnValue([]),
} as any;

// Mock navigator
Object.defineProperty(globalThis, 'navigator', {
  value: {
    onLine: true,
    sendBeacon: vi.fn(),
  },
  writable: true,
  configurable: true
});

describe('RevyntaTracker', () => {
  let tracker: RevyntaTracker;
  const mockEndpoint = 'https://api.test.revynta.com/v1/events';

  beforeEach(() => {
    mockLocalStorage.clear();
    mockSessionStorage.clear();
    vi.useFakeTimers();
    tracker = new RevyntaTracker();
    
    // Mock global fetch
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 'accepted' }),
      } as any)
    );

    // Reset online status
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should generate transient IDs when analytics consent is false', () => {
    tracker.init('test-store', {
      apiEndpoint: mockEndpoint,
      consent: { analytics: false },
    });

    expect(mockLocalStorage.getItem('revynta_visitor_id')).toBeNull();
    expect(mockSessionStorage.getItem('revynta_session_id')).toBeDefined();
  });

  it('should persist visitor ID when analytics consent is true', () => {
    tracker.init('test-store', {
      apiEndpoint: mockEndpoint,
      consent: { analytics: true },
    });

    const visitorId = mockLocalStorage.getItem('revynta_visitor_id');
    expect(visitorId).not.toBeNull();
    expect(typeof visitorId).toBe('string');
  });

  it('should respect opt-out and clear visitor ID from localStorage', () => {
    tracker.init('test-store', {
      apiEndpoint: mockEndpoint,
      consent: { analytics: true },
    });

    expect(mockLocalStorage.getItem('revynta_visitor_id')).not.toBeNull();

    tracker.setConsent({ analytics: false });
    expect(mockLocalStorage.getItem('revynta_visitor_id')).toBeNull();
  });

  it('should batch events and flush when maxBatchSize is reached', async () => {
    tracker.init('test-store', {
      apiEndpoint: mockEndpoint,
      maxBatchSize: 3,
      consent: { analytics: true },
    });

    tracker.track('page_view', { page: '/home' });
    tracker.track('product_view', { productId: 'p1' });

    // Should not have flushed yet
    expect(fetch).not.toHaveBeenCalled();

    // Trigger third event, reaching maxBatchSize = 3
    tracker.track('page_view', { page: '/about' });

    expect(fetch).toHaveBeenCalledTimes(1);
    const lastCall = vi.mocked(fetch).mock.calls[0];
    expect(lastCall[0]).toBe(mockEndpoint);
    expect(lastCall[1]?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Store-API-Key': 'test-store',
    });
    
    const parsedBody = JSON.parse(lastCall[1]?.body as string);
    expect(parsedBody.storeKey).toBe('test-store');
    expect(parsedBody.events.length).toBe(3);
    expect(parsedBody.events[1].eventType).toBe('product_view');
  });

  it('should flush buffer automatically based on batchIntervalMs', async () => {
    tracker.init('test-store', {
      apiEndpoint: mockEndpoint,
      batchIntervalMs: 2000,
      maxBatchSize: 100,
      consent: { analytics: true },
    });

    tracker.track('page_view', { page: '/home' });
    expect(fetch).not.toHaveBeenCalled();

    // Advance time by 2 seconds
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should buffer events in localStorage when offline', async () => {
    // Mock navigator.onLine as false
    Object.defineProperty(navigator, 'onLine', {
      value: false,
      writable: true,
    });

    tracker.init('test-store', {
      apiEndpoint: mockEndpoint,
      maxBatchSize: 1,
      consent: { analytics: true },
    });

    tracker.track('page_view', { page: '/home' });
    
    // Flush should check status and skip fetch
    await tracker.flush();
    
    expect(fetch).not.toHaveBeenCalled();
    
    const queue = JSON.parse(mockLocalStorage.getItem('revynta_offline_queue') || '[]');
    expect(queue.length).toBe(1);
    expect(queue[0].eventType).toBe('page_view');
  });
});
