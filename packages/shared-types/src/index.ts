export interface ConsentState {
  analytics: boolean;
  personalization: boolean;
  marketing: boolean;
}

export type EventType =
  | 'page_view'
  | 'product_view'
  | 'category_view'
  | 'search'
  | 'cart_add'
  | 'checkout_init'
  | 'purchase'
  | 'consent_change'
  | 'identify'
  | 'recommendation_impression'
  | 'recommendation_click'
  | 'recommendation_conversion';

export interface BaseEvent {
  eventId: string;
  sessionId: string;
  visitorId: string;
  eventType: EventType;
  timestamp: number;
  pageUrl: string;
  referrer?: string;
  metadata?: Record<string, any>;
}

export interface ProductViewEvent extends BaseEvent {
  eventType: 'product_view';
  productId: string;
  productName: string;
  price: number;
  categories: string[];
}

export interface SearchEvent extends BaseEvent {
  eventType: 'search';
  query: string;
}

export interface ConsentChangeEvent extends BaseEvent {
  eventType: 'consent_change';
  consentState: ConsentState;
}

export interface IdentifyEvent extends BaseEvent {
  eventType: 'identify';
  channel: 'whatsapp' | 'email' | 'sms';
  identityValue: string;
}

export interface RecommendationEvent extends BaseEvent {
  eventType: 'recommendation_impression' | 'recommendation_click' | 'recommendation_conversion';
  productId: string;
  strategy: string;
  recommendationId?: string;
}

export type TrackingEvent =
  | BaseEvent
  | ProductViewEvent
  | SearchEvent
  | ConsentChangeEvent
  | IdentifyEvent
  | RecommendationEvent;

export interface IngressEventBatch {
  storeKey: string;
  events: TrackingEvent[];
}

export interface EnrichedEvent {
  eventTime: string; // ISO 8601
  eventId: string;
  tenantId: string;
  sessionId: string;
  shopperId: string; // Resolved from visitor ID
  eventType: EventType;
  sdkVersion: string;
  pageUrl: string;
  referrer?: string;
  userAgent?: string;
  ipAddress?: string;
  country?: string;
  
  // Product details
  productId?: string;
  productPrice?: number;
  productCategories?: string[];
  productName?: string;
  
  // Search details
  query?: string;
  
  metadata?: Record<string, any>;
}

// ─── Recommendation Domain Types ─────────────────────────────────────

export type RecommendationStrategy =
  | 'personalized'
  | 'similar'
  | 'trending'
  | 'popular'
  | 'category'
  | 'cold_start'
  | 'hybrid';

export type RecommendationReasonCode =
  | 'PERSONALIZED_AFFINITY'
  | 'SIMILAR_PRODUCT'
  | 'TRENDING_STORE'
  | 'POPULAR_STORE'
  | 'CATEGORY_AFFINITY'
  | 'COLD_START';

export interface RecommendationItem {
  productId: string;
  sku: string;
  name: string;
  categories: string[];
  brand: string | null;
  price: number;
  score: number;
  reasonCode: RecommendationReasonCode;
  reason: string;
  source: string;
  metadata?: Record<string, any>;
}

export interface RecommendationResponse {
  recommendations: RecommendationItem[];
  strategy: RecommendationStrategy;
  generatedAt: string;
  modelVersion: string;
  cached?: boolean;
}

export interface RecommendationRequestParams {
  storeId: string;
  shopperId?: string;
  sessionId?: string;
  strategy?: RecommendationStrategy;
  productId?: string;
  category?: string;
  limit?: number;
}
