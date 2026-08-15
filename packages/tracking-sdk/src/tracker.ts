import { ConsentState, TrackingEvent, EventType } from '@revynta/shared-types';

export interface TrackerOptions {
  apiEndpoint?: string;
  batchIntervalMs?: number;
  maxBatchSize?: number;
  consent?: Partial<ConsentState>;
}

const DEFAULT_OPTIONS: Required<TrackerOptions> = {
  apiEndpoint: 'https://api.revynta.com/api/v1/events',
  batchIntervalMs: 5000,
  maxBatchSize: 10,
  consent: {
    analytics: false,
    personalization: false,
    marketing: false,
  },
};

export class RevyntaTracker {
  private storeKey: string = '';
  private options: Required<TrackerOptions> = DEFAULT_OPTIONS;
  private consentState: ConsentState = { analytics: false, personalization: false, marketing: false };
  private eventBuffer: TrackingEvent[] = [];
  private flushTimer: any = null;
  private visitorId: string = '';
  private sessionId: string = '';
  private isRetrying: boolean = false;
  private retryAttempt: number = 0;

  constructor() {
    // Listen for visibility and page unload events to send remaining logs
    if (typeof window !== 'undefined') {
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.flushSync();
        }
      });
      window.addEventListener('pagehide', () => this.flushSync());
      window.addEventListener('online', () => this.processOfflineQueue());
    }
  }

  public init(storeKey: string, options?: TrackerOptions): void {
    this.storeKey = storeKey;
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      consent: {
        ...DEFAULT_OPTIONS.consent,
        ...(options?.consent || {}),
      },
    };
    
    this.consentState = this.options.consent as ConsentState;
    this.initIdentifiers();
    this.setupFlushTimer();
    this.processOfflineQueue();
  }

  public setConsent(consent: Partial<ConsentState>): void {
    const previousConsent = { ...this.consentState };
    this.consentState = {
      ...this.consentState,
      ...consent,
    };

    // If analytics consent is given, upgrade to persistent visitor ID
    if (!previousConsent.analytics && this.consentState.analytics) {
      this.visitorId = this.getOrGenerateVisitorId(true);
    } else if (previousConsent.analytics && !this.consentState.analytics) {
      // Opt-out logic: remove from localStorage
      this.visitorId = this.generateUUID();
      try {
        localStorage.removeItem('revynta_visitor_id');
      } catch {}
    }

    this.track('consent_change', { consentState: this.consentState });
  }

  public track(eventType: EventType, metadata?: Record<string, any>): void {
    if (!this.storeKey) {
      console.warn('[Revynta] Tracker not initialized. Call init() first.');
      return;
    }

    // Privacy gating: block analytics & personalization if consent lacks
    if (eventType !== 'consent_change') {
      if (!this.consentState.analytics && !this.consentState.personalization) {
        // Drop tracking altogether if neither is permitted
        return;
      }
    }

    const baseEvent: TrackingEvent = {
      eventId: this.generateUUID(),
      sessionId: this.sessionId,
      visitorId: this.visitorId,
      eventType,
      timestamp: Date.now(),
      pageUrl: typeof window !== 'undefined' ? window.location.href : '',
      referrer: typeof document !== 'undefined' ? document.referrer : '',
      ...metadata,
    };

    this.eventBuffer.push(baseEvent);

    if (this.eventBuffer.length >= this.options.maxBatchSize) {
      this.flush();
    }
  }

  public identify(channel: 'whatsapp' | 'email' | 'sms', value: string): void {
    // Only permit identity linking if marketing/personalization is allowed
    if (!this.consentState.personalization) {
      return;
    }

    this.track('identify', {
      channel,
      identityValue: value,
    });
  }

  private initIdentifiers(): void {
    this.sessionId = this.getOrGenerateSessionId();
    this.visitorId = this.getOrGenerateVisitorId(this.consentState.analytics);
  }

  private getOrGenerateSessionId(): string {
    if (typeof window === 'undefined') return this.generateUUID();
    try {
      let sessId = sessionStorage.getItem('revynta_session_id');
      if (!sessId) {
        sessId = this.generateUUID();
        sessionStorage.setItem('revynta_session_id', sessId);
      }
      return sessId;
    } catch {
      return this.generateUUID();
    }
  }

  private getOrGenerateVisitorId(persist: boolean): string {
    if (typeof window === 'undefined') return this.generateUUID();
    if (!persist) {
      return this.generateUUID(); // Transient in-memory visitor ID
    }

    try {
      let visId = localStorage.getItem('revynta_visitor_id');
      if (!visId) {
        visId = this.generateUUID();
        localStorage.setItem('revynta_visitor_id', visId);
      }
      return visId;
    } catch {
      return this.generateUUID();
    }
  }

  private setupFlushTimer(): void {
    if (typeof window === 'undefined') return;
    if (this.flushTimer) clearInterval(this.flushTimer);
    
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.options.batchIntervalMs);
  }

  public async flush(): Promise<void> {
    if (this.eventBuffer.length === 0) return;

    const payload = {
      storeKey: this.storeKey,
      events: [...this.eventBuffer],
    };

    // Clear buffer immediately to prevent race conditions during async request
    const sentEvents = [...this.eventBuffer];
    this.eventBuffer = [];

    // Check online status
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.saveToOfflineQueue(sentEvents);
      return;
    }

    try {
      const response = await fetch(this.options.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Store-API-Key': this.storeKey,
        },
        body: JSON.stringify(payload),
        keepalive: true,
      });

      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
      }

      this.retryAttempt = 0;
    } catch (error) {
      console.error('[Revynta] Failed to send events:', error);
      // Re-queue events for retry
      this.saveToOfflineQueue(sentEvents);
      this.scheduleRetry();
    }
  }

  // Synchronous flush on tab close/unload
  private flushSync(): void {
    if (this.eventBuffer.length === 0 || !this.storeKey) return;

    const payload = JSON.stringify({
      storeKey: this.storeKey,
      events: this.eventBuffer,
    });

    this.eventBuffer = [];

    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(this.options.apiEndpoint, blob);
    } else {
      // Fallback to sync fetch if sendBeacon not supported
      try {
        fetch(this.options.apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Store-API-Key': this.storeKey,
          },
          body: payload,
          keepalive: true,
        });
      } catch {}
    }
  }

  private saveToOfflineQueue(events: TrackingEvent[]): void {
    if (typeof window === 'undefined') return;
    try {
      const existing = localStorage.getItem('revynta_offline_queue');
      const queue: TrackingEvent[] = existing ? JSON.parse(existing) : [];
      
      // Limit queue to prevent localStorage exhaustion (cap at 100 events)
      const merged = [...queue, ...events].slice(-100);
      localStorage.setItem('revynta_offline_queue', JSON.stringify(merged));
    } catch (e) {
      console.error('[Revynta] Failed to write to offline queue:', e);
    }
  }

  private async processOfflineQueue(): Promise<void> {
    if (typeof window === 'undefined' || this.isRetrying) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    try {
      const existing = localStorage.getItem('revynta_offline_queue');
      if (!existing) return;

      const events: TrackingEvent[] = JSON.parse(existing);
      if (events.length === 0) return;

      this.isRetrying = true;

      // Send in chunks of maxBatchSize
      while (events.length > 0) {
        const chunk = events.splice(0, this.options.maxBatchSize);
        const payload = {
          storeKey: this.storeKey,
          events: chunk,
        };

        const response = await fetch(this.options.apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Store-API-Key': this.storeKey,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          // Re-insert failed chunk to front of queue and halt
          events.unshift(...chunk);
          localStorage.setItem('revynta_offline_queue', JSON.stringify(events));
          throw new Error(`Offline sync failed: ${response.status}`);
        }
      }

      localStorage.removeItem('revynta_offline_queue');
      this.retryAttempt = 0;
    } catch (error) {
      console.warn('[Revynta] Offline queue sync failed. Will retry later:', error);
      this.scheduleRetry();
    } finally {
      this.isRetrying = false;
    }
  }

  private scheduleRetry(): void {
    if (this.isRetrying) return;

    this.retryAttempt++;
    // Exponential backoff with jitter
    const baseDelay = 1000;
    const maxDelay = 30000;
    const exponentialDelay = Math.min(maxDelay, baseDelay * Math.pow(2, this.retryAttempt));
    const jitter = Math.random() * 1000;
    const totalDelay = exponentialDelay + jitter;

    setTimeout(() => {
      this.processOfflineQueue();
    }, totalDelay);
  }

  private generateUUID(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Fallback UUID v4 generator
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
