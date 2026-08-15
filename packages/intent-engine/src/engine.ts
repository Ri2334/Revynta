import { EnrichedEvent } from '@revynta/shared-types';
import { IntentModel, IntentConfig, SessionState, IntentResult, SignalContribution } from './types.js';
import { loadIntentConfig } from './config.js';

export class HeuristicIntentModel implements IntentModel {
  public readonly version: string;
  private config: IntentConfig;

  constructor(config?: IntentConfig) {
    this.config = config || loadIntentConfig();
    this.version = this.config.modelVersion || 'v1';
  }

  /**
   * Processes an incoming enriched event into a SignalContribution.
   */
  public processEventSignal(session: SessionState, event: EnrichedEvent): SignalContribution | null {
    const { eventType, productId } = event;
    const weights = this.config.weights;

    let signalType = eventType as string;
    let baseWeight = weights[eventType] ?? 1;
    let details: string | undefined;

    if (eventType === 'product_view' && productId) {
      const prevCount = session.viewedProducts[productId] || 0;
      if (prevCount > 0) {
        signalType = 'repeat_product_view';
        baseWeight = weights.repeat_product_view ?? 10;
        details = `Repeat view of product ${productId} (${prevCount + 1}x)`;
      } else {
        details = `Viewed product ${productId}`;
      }
    } else if (eventType === 'search') {
      details = event.query ? `Searched: "${event.query}"` : 'Search query executed';
    } else if (eventType === 'cart_add') {
      details = productId ? `Added product ${productId} to cart` : 'Added item to cart';
    } else if (eventType === 'checkout_init') {
      details = 'Initiated checkout sequence';
    }

    return {
      type: signalType,
      weight: baseWeight,
      timestamp: event.eventTime || new Date().toISOString(),
      details,
    };
  }

  /**
   * Calculates the recency-decayed intent score, segment, and explanations.
   */
  public calculateIntent(session: SessionState, currentEvent?: EnrichedEvent): IntentResult {
    // If purchase completed, intent is suppressed (0)
    if (session.purchaseCompleted) {
      return {
        score: 0,
        segment: 'low',
        explanations: [],
        modelVersion: this.version,
        isPurchased: true,
      };
    }

    const now = Date.now();
    const signals = [...session.signals];

    // Optionally include current event signal if passed and not yet added to session
    if (currentEvent) {
      const newSignal = this.processEventSignal(session, currentEvent);
      if (newSignal) {
        signals.push(newSignal);
      }
    }

    let rawScore = 0;
    const decayedContributions: Array<{ signal: SignalContribution; decayedWeight: number }> = [];

    for (const signal of signals) {
      const signalTime = new Date(signal.timestamp).getTime();
      const ageInHours = Math.max(0, (now - signalTime) / (1000 * 60 * 60));

      const halfLife =
        this.config.decayHalfLifeHours[signal.type] ||
        this.config.decayHalfLifeHours.default ||
        48;

      const decayFactor = Math.pow(0.5, ageInHours / halfLife);
      const decayedWeight = Math.round(signal.weight * decayFactor * 10) / 10;

      rawScore += decayedWeight;
      decayedContributions.push({ signal, decayedWeight });
    }

    // Clamp score between 0 and 100
    const finalScore = Math.max(0, Math.min(100, Math.round(rawScore)));

    // Determine segment based on thresholds
    let segment: 'low' | 'medium' | 'high' = 'low';
    if (finalScore >= this.config.thresholds.high[0]) {
      segment = 'high';
    } else if (finalScore >= this.config.thresholds.medium[0]) {
      segment = 'medium';
    }

    // Extract top 5 contributing signals (sorted by decayed weight descending)
    decayedContributions.sort((a, b) => Math.abs(b.decayedWeight) - Math.abs(a.decayedWeight));
    const explanations: SignalContribution[] = decayedContributions
      .slice(0, 5)
      .map((item) => ({
        type: item.signal.type,
        weight: item.decayedWeight,
        timestamp: item.signal.timestamp,
        details: item.signal.details,
      }));

    return {
      score: finalScore,
      segment,
      explanations,
      modelVersion: this.version,
      isPurchased: false,
    };
  }
}
