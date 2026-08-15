import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { IntentConfig } from './types.js';

const defaultConfig: IntentConfig = {
  modelVersion: 'v1',
  inactivityThresholdMinutes: 30,
  affinityCap: 200,
  thresholds: {
    low: [0, 29],
    medium: [30, 69],
    high: [70, 100],
  },
  weights: {
    page_view: 1,
    product_view: 5,
    repeat_product_view: 10,
    category_view: 3,
    search: 8,
    search_refinement: 10,
    filter: 6,
    variant_selection: 8,
    color_selection: 8,
    size_selection: 8,
    wishlist: 15,
    cart_add: 25,
    checkout_init: 50,
    purchase: 0,
    short_dwell: -5,
    bounce: -10,
  },
  decayHalfLifeHours: {
    search: 24,
    product_view: 48,
    cart_add: 48,
    default: 48,
  },
};

let cachedConfig: IntentConfig | null = null;

export function loadIntentConfig(): IntentConfig {
  if (cachedConfig) return cachedConfig;

  const possiblePaths = [
    resolve(process.cwd(), 'config/intent_config.json'),
    resolve(process.cwd(), '../../config/intent_config.json'),
    resolve(process.cwd(), '../config/intent_config.json'),
  ];

  for (const configPath of possiblePaths) {
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8');
        cachedConfig = JSON.parse(raw) as IntentConfig;
        return cachedConfig;
      } catch (err) {
        // Fall back to default
      }
    }
  }

  cachedConfig = defaultConfig;
  return cachedConfig;
}

export function setIntentConfigOverride(config: Partial<IntentConfig>): void {
  cachedConfig = { ...loadIntentConfig(), ...config };
}
