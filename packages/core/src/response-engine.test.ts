import { describe, expect, it, beforeEach } from 'vitest';
import {
  renderTemplate,
  renderDeep,
  resolveSequence,
  resetSequenceCounters,
  buildRequestContext
} from './response-engine.ts';
import type { MockEndpoint } from './types.ts';

function makeCtx() {
  return buildRequestContext({
    body: { user: { id: 42, name: 'Alice' }, role: 'admin' },
    query: { page: '2', limit: '10' },
    params: { id: '99' },
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok_123' },
    method: 'POST',
    path: '/users/99'
  });
}

describe('renderTemplate', () => {
  it('replaces faker.name', () => {
    const result = renderTemplate('Hello {{faker.firstName}}', makeCtx());
    expect(result).toMatch(/^Hello (Alice|Bob|Charlie|Diana|Eve|Frank|Grace|Hank)$/);
  });

  it('replaces faker.email', () => {
    const result = renderTemplate('{{faker.email}}', makeCtx());
    expect(result).toMatch(/@/);
  });

  it('replaces faker.uuid', () => {
    const result = renderTemplate('{{faker.uuid}}', makeCtx());
    expect(result).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('replaces faker.int', () => {
    const result = renderTemplate('{{faker.int}}', makeCtx());
    expect(Number(result)).toBeGreaterThanOrEqual(1);
  });

  it('replaces request.body path', () => {
    const result = renderTemplate('{{request.body.user.name}}', makeCtx());
    expect(result).toBe('Alice');
  });

  it('replaces request.body nested path', () => {
    const result = renderTemplate('{{request.body.user.id}}', makeCtx());
    expect(result).toBe('42');
  });

  it('replaces request.query value', () => {
    const result = renderTemplate('page={{request.query.page}}', makeCtx());
    expect(result).toBe('page=2');
  });

  it('replaces request.params value', () => {
    const result = renderTemplate('{{request.params.id}}', makeCtx());
    expect(result).toBe('99');
  });

  it('replaces request.headers value', () => {
    const result = renderTemplate('{{request.headers.authorization}}', makeCtx());
    expect(result).toBe('Bearer tok_123');
  });

  it('replaces now()', () => {
    const result = renderTemplate('{{now}}', makeCtx());
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('replaces now(iso)', () => {
    const result = renderTemplate('{{now(iso)}}', makeCtx());
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('replaces now(date)', () => {
    const result = renderTemplate('{{now(date)}}', makeCtx());
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('replaces now(timestamp)', () => {
    const result = renderTemplate('{{now(timestamp)}}', makeCtx());
    expect(Number(result)).toBeGreaterThan(1000000000);
  });

  it('replaces randomInt', () => {
    const result = renderTemplate('{{randomInt(5,10)}}', makeCtx());
    const val = Number(result);
    expect(val).toBeGreaterThanOrEqual(5);
    expect(val).toBeLessThanOrEqual(10);
  });

  it('renders multiple replacements in one string', () => {
    const result = renderTemplate('{{faker.firstName}} {{faker.lastName}}', makeCtx());
    expect(result).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it('passes through text without templates', () => {
    const result = renderTemplate('plain text', makeCtx());
    expect(result).toBe('plain text');
  });

  it('handles empty template', () => {
    expect(renderTemplate('', makeCtx())).toBe('');
  });

  it('returns unknown faker prop as-is', () => {
    const result = renderTemplate('{{faker.unknown}}', makeCtx());
    expect(result).toContain('unknown');
  });
});

describe('renderDeep', () => {
  it('renders templates in nested objects', () => {
    const input = {
      name: '{{faker.firstName}}',
      nested: {
        email: '{{faker.email}}',
        plain: 42
      }
    };
    const result = renderDeep(input, makeCtx()) as Record<string, unknown>;
    expect(typeof result.name).toBe('string');
    expect((result.name as string).length).toBeGreaterThan(0);
    expect((result.nested as Record<string, unknown>).plain).toBe(42);
  });

  it('renders templates in arrays', () => {
    const input = ['{{faker.firstName}}', '{{faker.lastName}}'];
    const result = renderDeep(input, makeCtx()) as string[];
    expect(result).toHaveLength(2);
    expect(result[0]?.length).toBeGreaterThan(0);
  });
});

describe('resolveSequence', () => {
  beforeEach(() => {
    resetSequenceCounters();
  });

  function makeEndpoint(overrides: Partial<MockEndpoint>): MockEndpoint {
    return {
      id: 'ep1',
      mockId: 'mock1',
      name: 'test',
      method: 'GET',
      path: '/test',
      requestHeaders: {},
      pathParameters: [],
      queryParameters: [],
      statusCode: 200,
      latencyMs: 0,
      errorRate: 0,
      tableName: 'test',
      orderIndex: 0,
      ...overrides
    };
  }

  it('returns null when no sequence defined', () => {
    const ep = makeEndpoint({});
    expect(resolveSequence(ep)).toBeNull();
  });

  it('returns first item on first call', () => {
    const ep = makeEndpoint({
      responseSequence: [
        { statusCode: 202, body: { status: 'processing' } },
        { statusCode: 200, body: { status: 'done' } }
      ]
    });
    const result = resolveSequence(ep);
    expect(result).toEqual({ body: { status: 'processing' }, statusCode: 202, latencyMs: 0 });
  });

  it('returns second item on second call', () => {
    const ep = makeEndpoint({
      responseSequence: [
        { statusCode: 202, body: { status: 'processing' } },
        { statusCode: 200, body: { status: 'done' } }
      ]
    });
    resolveSequence(ep);
    const result = resolveSequence(ep);
    expect(result).toEqual({ body: { status: 'done' }, statusCode: 200, latencyMs: 0 });
  });

  it('cycles back to first item after end', () => {
    const ep = makeEndpoint({
      responseSequence: [
        { statusCode: 202, body: { status: 'processing' } }
      ]
    });
    resolveSequence(ep);
    resolveSequence(ep);
    const result = resolveSequence(ep);
    expect(result?.statusCode).toBe(202);
  });

  it('returns per-endpoint latency from sequence item', () => {
    const ep = makeEndpoint({
      responseSequence: [
        { statusCode: 200, body: {}, latencyMs: 3000 }
      ]
    });
    const result = resolveSequence(ep);
    expect(result?.latencyMs).toBe(3000);
  });

  it('uses separate counters per endpoint', () => {
    const ep1 = makeEndpoint({ id: 'ep1', responseSequence: [{ statusCode: 200, body: {} }, { statusCode: 404, body: {} }] });
    const ep2 = makeEndpoint({ id: 'ep2', responseSequence: [{ statusCode: 201, body: {} }] });

    resolveSequence(ep1);
    const r1 = resolveSequence(ep1);
    expect(r1?.statusCode).toBe(404);

    const r2 = resolveSequence(ep2);
    expect(r2?.statusCode).toBe(201);
  });
});
