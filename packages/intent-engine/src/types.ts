import { EnrichedEvent } from '@revynta/shared-types';

export interface IntentConfig {
  modelVersion: string;
  inactivityThresholdMinutes: number;
  affinityCap: number;
  thresholds: {
    low: [number, number];
    medium: [number, number];
    high: [number, number];
  };
  weights: Record<string, number>;
  decayHalfLifeHours: Record<string, number>;
}

export interface SignalContribution {
  type: string;
  weight: number;
  timestamp: string; // ISO 8601 string
  details?: string;
}

export interface IntentResult {
  score: number;
  segment: 'low' | 'medium' | 'high';
  explanations: SignalContribution[]; // Top 5 contributing factors
  modelVersion: string;
  isPurchased?: boolean;
}

export interface SessionState {
  tenantId: string;
  storeId: string;
  sessionId: string;
  shopperId: string;
  lastActivityAt: string;
  lastEventTimestamp: number;
  eventCount: number;
  pageViews: number;
  productViews: number;
  cartAdds: number;
  checkoutInitiations: number;
  purchaseCompleted: boolean;
  convertedAt?: string;
  viewedProducts: Record<string, number>; // productId -> count
  viewedCategories: Record<string, number>; // category -> score/count
  signals: SignalContribution[];
}

export interface IntentModel {
  readonly version: string;
  calculateIntent(session: SessionState, event?: EnrichedEvent): IntentResult;
  processEventSignal(session: SessionState, event: EnrichedEvent): SignalContribution | null;
}
