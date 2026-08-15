import { RecommendationItem } from '@revynta/shared-types';
import { EvaluationMetrics } from './types.js';

export class RecommendationEvaluator {
  /**
   * Evaluates precision, recall, hit rate, catalog coverage, and diversity for top K recommendations against ground truth interactions.
   */
  public evaluate(
    recommendations: RecommendationItem[],
    relevantProductIds: string[],
    catalogTotalCount: number,
    k: number = 5
  ): EvaluationMetrics {
    const topK = recommendations.slice(0, k);
    const recommendedIds = topK.map((r) => r.productId);

    if (topK.length === 0 || relevantProductIds.length === 0) {
      return {
        precisionAtK: 0,
        recallAtK: 0,
        hitRateAtK: 0,
        coverage: 0,
        diversityIndex: 0,
      };
    }

    const relevantSet = new Set(relevantProductIds);
    const hits = recommendedIds.filter((id) => relevantSet.has(id));

    const precisionAtK = parseFloat((hits.length / topK.length).toFixed(4));
    const recallAtK = parseFloat((hits.length / relevantSet.size).toFixed(4));
    const hitRateAtK = hits.length > 0 ? 1 : 0;
    const coverage = catalogTotalCount > 0 ? parseFloat((new Set(recommendedIds).size / catalogTotalCount).toFixed(4)) : 0;

    // Calculate Category Diversity Index (entropy across categories in top K)
    const categoryCounts: Record<string, number> = {};
    for (const rec of topK) {
      const cat = rec.categories[0] || 'uncategorized';
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }

    let entropy = 0;
    const totalRecs = topK.length;
    for (const cat in categoryCounts) {
      const p = categoryCounts[cat] / totalRecs;
      entropy -= p * Math.log2(p);
    }

    const maxEntropy = Math.log2(Math.max(1, Object.keys(categoryCounts).length));
    const diversityIndex = maxEntropy > 0 ? parseFloat((entropy / maxEntropy).toFixed(4)) : 1.0;

    return {
      precisionAtK,
      recallAtK,
      hitRateAtK,
      coverage,
      diversityIndex,
    };
  }
}
