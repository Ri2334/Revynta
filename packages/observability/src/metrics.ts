class Counter {
  private values = new Map<string, number>();

  constructor(public readonly name: string, public readonly help: string, public readonly labelNames: string[] = []) {}

  public inc(labels: Record<string, string> = {}, value: number = 1): void {
    const key = this.formatKey(labels);
    this.values.set(key, (this.values.get(key) || 0) + value);
  }

  public get(labels: Record<string, string> = {}): number {
    const key = this.formatKey(labels);
    return this.values.get(key) || 0;
  }

  public reset(): void {
    this.values.clear();
  }

  public toPrometheus(): string {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n`;
    if (this.values.size === 0) {
      out += `${this.name} 0\n`;
      return out;
    }
    for (const [key, val] of this.values.entries()) {
      out += `${this.name}${key} ${val}\n`;
    }
    return out;
  }

  private formatKey(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    const formatted = entries.map(([k, v]) => `${k}="${v}"`).join(',');
    return `{${formatted}}`;
  }
}

class Histogram {
  private counts = new Map<string, number>();
  private sums = new Map<string, number>();

  constructor(public readonly name: string, public readonly help: string, public readonly labelNames: string[] = []) {}

  public observe(labels: Record<string, string> = {}, value: number): void {
    const key = this.formatKey(labels);
    this.counts.set(key, (this.counts.get(key) || 0) + 1);
    this.sums.set(key, (this.sums.get(key) || 0) + value);
  }

  public reset(): void {
    this.counts.clear();
    this.sums.clear();
  }

  public toPrometheus(): string {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} histogram\n`;
    if (this.counts.size === 0) {
      out += `${this.name}_count 0\n${this.name}_sum 0\n`;
      return out;
    }
    for (const [key, count] of this.counts.entries()) {
      const sum = this.sums.get(key) || 0;
      out += `${this.name}_count${key} ${count}\n`;
      out += `${this.name}_sum${key} ${sum.toFixed(6)}\n`;
    }
    return out;
  }

  private formatKey(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    const formatted = entries.map(([k, v]) => `${k}="${v}"`).join(',');
    return `{${formatted}}`;
  }
}

class Gauge {
  private values = new Map<string, number>();

  constructor(public readonly name: string, public readonly help: string, public readonly labelNames: string[] = []) {}

  public set(labels: Record<string, string> = {}, value: number): void {
    const key = this.formatKey(labels);
    this.values.set(key, value);
  }

  public get(labels: Record<string, string> = {}): number {
    const key = this.formatKey(labels);
    return this.values.get(key) || 0;
  }

  public reset(): void {
    this.values.clear();
  }

  public toPrometheus(): string {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n`;
    if (this.values.size === 0) {
      out += `${this.name} 0\n`;
      return out;
    }
    for (const [key, val] of this.values.entries()) {
      out += `${this.name}${key} ${val}\n`;
    }
    return out;
  }

  private formatKey(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    const formatted = entries.map(([k, v]) => `${k}="${v}"`).join(',');
    return `{${formatted}}`;
  }
}

// Global Metrics Registry
export const metrics = {
  // HTTP Metrics
  httpRequestsTotal: new Counter('revynta_http_requests_total', 'Total HTTP requests processed', ['method', 'route', 'status']),
  httpRequestDurationSeconds: new Histogram('revynta_http_request_duration_seconds', 'HTTP request latency in seconds', ['method', 'route']),

  // Ingestion Metrics
  eventsIngestedTotal: new Counter('revynta_events_ingested_total', 'Total tracking events ingested', ['eventType']),
  eventsRejectedTotal: new Counter('revynta_events_rejected_total', 'Total tracking events rejected', ['reason']),
  ingestionLatencySeconds: new Histogram('revynta_ingestion_latency_seconds', 'Ingestion API batch latency in seconds'),

  // Kafka Consumer Metrics
  kafkaEventsConsumedTotal: new Counter('revynta_kafka_events_consumed_total', 'Kafka events consumed by workers', ['consumerGroup', 'topic']),
  kafkaConsumerDurationSeconds: new Histogram('revynta_kafka_consumer_duration_seconds', 'Consumer processing duration in seconds', ['consumerGroup']),
  kafkaDlqTotal: new Counter('revynta_kafka_dlq_total', 'Events routed to Dead Letter Queue', ['consumerGroup', 'topic']),

  // Redis Metrics
  redisOperationsTotal: new Counter('revynta_redis_operations_total', 'Total Redis commands executed', ['command']),
  redisCacheHitsTotal: new Counter('revynta_redis_cache_hits_total', 'Total Redis cache hits', ['cacheType']),
  redisCacheMissesTotal: new Counter('revynta_redis_cache_misses_total', 'Total Redis cache misses', ['cacheType']),

  // PostgreSQL Metrics
  dbQueriesTotal: new Counter('revynta_db_queries_total', 'Total PostgreSQL queries executed', ['operation']),
  dbQueryDurationSeconds: new Histogram('revynta_db_query_duration_seconds', 'PostgreSQL query duration in seconds'),

  // ClickHouse Metrics
  clickhouseQueriesTotal: new Counter('revynta_clickhouse_queries_total', 'Total ClickHouse analytics queries', ['queryType']),
  clickhouseQueryDurationSeconds: new Histogram('revynta_clickhouse_query_duration_seconds', 'ClickHouse query duration in seconds'),

  // Campaign Engine Metrics
  campaignEvaluationsTotal: new Counter('revynta_campaign_evaluations_total', 'Total inactivity campaign evaluations', ['result']),
  campaignEligibleTotal: new Counter('revynta_campaign_eligible_total', 'Campaign eligibility events emitted'),

  // WhatsApp Metrics
  whatsappDispatchesTotal: new Counter('revynta_whatsapp_dispatches_total', 'WhatsApp dispatches executed', ['provider', 'status']),
  whatsappFailuresTotal: new Counter('revynta_whatsapp_failures_total', 'WhatsApp dispatch failures', ['reason']),

  // Recommendation Engine Metrics
  recommendationRequestsTotal: new Counter('revynta_recommendation_requests_total', 'Total recommendation requests', ['strategy']),
  recommendationLatencySeconds: new Histogram('revynta_recommendation_latency_seconds', 'Recommendation generation latency in seconds'),
  recommendationCacheHitsTotal: new Counter('revynta_recommendation_cache_hits_total', 'Recommendation Redis cache hits'),
  recommendationCacheMissesTotal: new Counter('revynta_recommendation_cache_misses_total', 'Recommendation Redis cache misses'),

  // Gauges
  activeConnectionsGauge: new Gauge('revynta_active_connections', 'Current active HTTP connections'),
};

/**
 * Returns full Prometheus text-format output of all metrics
 */
export function getMetrics(): string {
  let output = '';
  for (const key of Object.keys(metrics)) {
    const metric = (metrics as any)[key];
    if (metric && typeof metric.toPrometheus === 'function') {
      output += metric.toPrometheus() + '\n';
    }
  }
  return output;
}

export function getMetricsContentType(): string {
  return 'text/plain; version=0.0.4; charset=utf-8';
}
