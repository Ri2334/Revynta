import crypto from 'crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  correlationId: string;
  parentSpanId?: string;
}

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  attributes: Record<string, any>;
  end: (attributes?: Record<string, any>) => void;
}

let activeCorrelationId: string | null = null;

export function getCorrelationId(): string {
  if (!activeCorrelationId) {
    activeCorrelationId = crypto.randomUUID();
  }
  return activeCorrelationId;
}

export function setCorrelationId(id: string): void {
  activeCorrelationId = id;
}

export function createTraceContext(existingCorrelationId?: string): TraceContext {
  const correlationId = existingCorrelationId || activeCorrelationId || crypto.randomUUID();
  setCorrelationId(correlationId);
  return {
    traceId: crypto.randomBytes(16).toString('hex'),
    spanId: crypto.randomBytes(8).toString('hex'),
    correlationId,
  };
}

export function startTraceSpan(name: string, context?: Partial<TraceContext>, attributes: Record<string, any> = {}): TraceSpan {
  const traceId = context?.traceId || crypto.randomBytes(16).toString('hex');
  const spanId = crypto.randomBytes(8).toString('hex');
  const parentSpanId = context?.spanId;
  const startTime = Date.now();

  const safeAttributes = { ...attributes };
  // Redact sensitive keys in tracing attributes
  const sensitiveKeys = ['password', 'accessToken', 'rawKey', 'keyHash', 'secret'];
  for (const k of Object.keys(safeAttributes)) {
    if (sensitiveKeys.some((sk) => k.toLowerCase().includes(sk.toLowerCase()))) {
      safeAttributes[k] = '[REDACTED]';
    }
  }

  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    startTime,
    attributes: safeAttributes,
    end: (extraAttributes = {}) => {
      const durationMs = Date.now() - startTime;
      // Tracing span completion log
    },
  };
}

export function injectTraceHeaders(headers: Record<string, string>, context: TraceContext): Record<string, string> {
  return {
    ...headers,
    'x-correlation-id': context.correlationId,
    'x-trace-id': context.traceId,
    'x-span-id': context.spanId,
  };
}

export function extractTraceHeaders(headers: Record<string, any>): TraceContext {
  const correlationId = headers['x-correlation-id'] || headers['x-request-id'] || crypto.randomUUID();
  const traceId = headers['x-trace-id'] || crypto.randomBytes(16).toString('hex');
  const parentSpanId = headers['x-span-id'];
  const spanId = crypto.randomBytes(8).toString('hex');

  setCorrelationId(correlationId);

  return {
    traceId,
    spanId,
    correlationId,
    parentSpanId,
  };
}
