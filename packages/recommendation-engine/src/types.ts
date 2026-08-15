import { ProductRecord } from '@revynta/database';
import { RecommendationStrategy, RecommendationReasonCode, RecommendationItem } from '@revynta/shared-types';

export interface RecommendationConfig {
  modelVersion: string;
  defaultLimit: number;
  maxLimit: number;
  cacheTtlSeconds: number;
  diversityCapPerCategory: number;
  weights: {
    personalized: number;
    affinity: number;
    intent: number;
    popularity: number;
    trend: number;
    similarity: number;
    category: number;
    freshness: number;
  };
  penalties: {
    repetition: number;
    purchased: number;
    unavailable: number;
  };
}

export interface ShopperFeatures {
  storeId: string;
  shopperId?: string;
  sessionId?: string;
  intentScore: number;
  intentSegment: string;
  isPurchased: boolean;
  topProductAffinities: Array<{ member: string; score: number }>;
  topCategoryAffinities: Array<{ member: string; score: number }>;
  recentViewedProductIds: string[];
  recentCategories: string[];
  personalizationConsent: boolean;
}

export interface RecommendationCandidate {
  product: ProductRecord;
  source: string;
  sourceScore: number;
  componentScores: {
    personalizedScore: number;
    affinityScore: number;
    intentScore: number;
    popularityScore: number;
    trendScore: number;
    similarityScore: number;
    categoryScore: number;
    freshnessScore: number;
  };
  penalties: {
    repetitionPenalty: number;
    purchasedPenalty: number;
    unavailablePenalty: number;
  };
}

export interface RecommendationCandidateSource {
  readonly name: string;
  generateCandidates(
    storeId: string,
    features: ShopperFeatures,
    options?: { productId?: string; category?: string; limit?: number }
  ): Promise<RecommendationCandidate[]>;
}

export interface EvaluationMetrics {
  precisionAtK: number;
  recallAtK: number;
  hitRateAtK: number;
  coverage: number;
  diversityIndex: number;
}
