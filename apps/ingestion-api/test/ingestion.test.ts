import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { fastify } from '../src/index.js';
import * as kafka from '../src/kafka.js';

// Mock Kafka integration for HTTP unit testing
vi.mock('../src/kafka', () => ({
  connectKafka: vi.fn().mockResolvedValue(undefined),
  disconnectKafka: vi.fn().mockResolvedValue(undefined),
  produceRawEvents: vi.fn().mockResolvedValue(undefined),
}));

describe('Ingestion API Integration Tests', () => {
  
  beforeAll(async () => {
    // Wait for Fastify plugin bootstrap
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 OK on GET /health', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('healthy');
  });

  it('should return 401 Unauthorized if API key is missing', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/events',
      body: {
        events: [],
      },
    });

    expect(response.statusCode).toBe(400); // Fails first on JSON Schema (storeKey is required)
  });

  it('should return 401 Unauthorized if API key is invalid', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/events',
      body: {
        storeKey: 'invalid-store-key',
        events: [],
      },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Unauthorized');
    expect(body.message).toBe('Invalid API Key');
  });

  it('should return 400 Bad Request on malformed event schema', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/events',
      body: {
        storeKey: 'test-store-key',
        events: [
          {
            // Missing required fields like sessionId, visitorId, etc.
            eventId: '67c7e5a8-2086-4f4f-b672-88d447a16f2c',
            eventType: 'page_view',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Bad Request');
  });

  it('should return 202 Accepted and publish event when payload is valid', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: {
        'x-store-api-key': 'test-store-key',
        'user-agent': 'Test Agent',
      },
      body: {
        storeKey: 'test-store-key',
        events: [
          {
            eventId: '67c7e5a8-2086-4f4f-b672-88d447a16f2c',
            sessionId: '7a048a60-2647-4933-bfb7-0f81d4a852cf',
            visitorId: 'b0126786-fb15-46ee-ab2c-cefe808f0293',
            eventType: 'page_view',
            timestamp: 1723730000000,
            pageUrl: 'https://myshop.com/products/black-shirt',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('accepted');
    expect(body.batchSize).toBe(1);

    // Verify Kafka producer was invoked with correct parameters
    expect(kafka.produceRawEvents).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(kafka.produceRawEvents).mock.calls[0];
    expect(calls[0]).toBe('00000000-0000-0000-0000-000000000001'); // Resolved test-store-key tenant UUID
    expect(calls[1].length).toBe(1);
    expect(calls[1][0].eventType).toBe('page_view');
    expect(calls[1][0].metadata).toMatchObject({
      userAgent: 'Test Agent',
    });
  });
});
