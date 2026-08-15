import { RecommendationConfig } from './types.js';

export const defaultConfig: RecommendationConfig = {
  modelVersion: 'hybrid-v1',
  defaultLimit: 10,
  maxLimit: 50,
  cacheTtlSeconds: 300, // 5 minutes
  diversityCapPerCategory: 3,
  weights: {
    personalized: 0.25,
    affinity: 0.20,
    intent: 0.15,
    popularity: 0.10,
    trend: 0.15,
    similarity: 0.10,
    category: 0.05,
    freshness: 0.05,
  },
  penalties: {
    repetition: 0.30,
    purchased: 1.0,
    unavailable: 1.0,
  },
};

export function loadRecommendationConfig(overrides?: Partial<RecommendationConfig>): RecommendationConfig {
  return {
    ...defaultConfig,
    ...overrides,
    weights: {
      ...defaultConfig.weights,
      ...(overrides?.weights || {}),
    },
    penalties: {
      ...defaultConfig.penalties,
      ...(overrides?.penalties || {}),
    },
  };
}
