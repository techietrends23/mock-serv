import { describe, expect, it } from 'vitest';
import {
  parseGraphqlRequestBody,
  requestGraphqlOperationName,
  endpointGraphqlOperationName,
  graphqlOperationMatches
} from './graphql-match.ts';
import type { MockEndpoint } from './types.ts';

describe('parseGraphqlRequestBody', () => {
  it('parses a JSON string body', () => {
    const result = parseGraphqlRequestBody('{"operationName":"Foo"}');
    expect(result).toEqual({ operationName: 'Foo' });
  });

  it('returns null for invalid JSON string', () => {
    const result = parseGraphqlRequestBody('not-json');
    expect(result).toBeNull();
  });

  it('passes through an object', () => {
    const result = parseGraphqlRequestBody({ operationName: 'Foo' });
    expect(result).toEqual({ operationName: 'Foo' });
  });

  it('returns null for non-object values', () => {
    expect(parseGraphqlRequestBody('string')).toBeNull();
    expect(parseGraphqlRequestBody(123)).toBeNull();
    expect(parseGraphqlRequestBody(null)).toBeNull();
  });

  it('returns null for arrays', () => {
    expect(parseGraphqlRequestBody(['a', 'b'])).toBeNull();
  });
});

describe('requestGraphqlOperationName', () => {
  it('extracts operationName from object body', () => {
    expect(requestGraphqlOperationName({ operationName: 'GetProducts' })).toBe('GetProducts');
  });

  it('extracts operationName from JSON string body', () => {
    expect(requestGraphqlOperationName('{"operationName":"GetProducts"}')).toBe('GetProducts');
  });

  it('trims whitespace from operationName', () => {
    expect(requestGraphqlOperationName({ operationName: '  GetProducts  ' })).toBe('GetProducts');
  });

  it('returns null when no operationName', () => {
    expect(requestGraphqlOperationName({ query: '{ users }' })).toBeNull();
  });

  it('returns null for empty operationName', () => {
    expect(requestGraphqlOperationName({ operationName: '' })).toBeNull();
  });

  it('returns null for non-object body', () => {
    expect(requestGraphqlOperationName('plain text')).toBeNull();
  });
});

describe('graphqlOperationMatches', () => {
  function makeEndpoint(overrides: Partial<MockEndpoint> = {}): MockEndpoint {
    return {
      id: 'ep1',
      mockId: 'mock1',
      name: 'test',
      method: 'POST',
      path: '/gateway/graphql',
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

  it('returns true when path is not GraphQL', () => {
    const endpoint = makeEndpoint({ path: '/api/users' });
    expect(graphqlOperationMatches(endpoint, { operationName: 'GetUsers' })).toBe(true);
  });

  it('returns true when endpoint has no specific operation', () => {
    const endpoint = makeEndpoint({ path: '/gateway/graphql' });
    expect(graphqlOperationMatches(endpoint, { operationName: 'GetProducts' })).toBe(true);
  });

  it('returns true when operation names match via summary', () => {
    const endpoint = makeEndpoint({
      path: '/gateway/graphql',
      summary: 'GetProducts'
    });
    expect(graphqlOperationMatches(endpoint, { operationName: 'GetProducts' })).toBe(true);
  });

  it('returns false when operation names differ', () => {
    const endpoint = makeEndpoint({
      path: '/gateway/graphql',
      summary: 'GetProducts'
    });
    expect(graphqlOperationMatches(endpoint, { operationName: 'GetUsers' })).toBe(false);
  });

  it('matches via description regex', () => {
    const endpoint = makeEndpoint({
      path: '/gateway/graphql',
      description: 'operationName: GetProducts'
    });
    expect(graphqlOperationMatches(endpoint, { operationName: 'GetProducts' })).toBe(true);
  });

  it('matches via requestBodySchema example', () => {
    const endpoint = makeEndpoint({
      path: '/gateway/graphql',
      requestBodySchema: {
        type: 'object',
        properties: {
          operationName: { type: 'string', example: 'GetProducts' }
        }
      }
    });
    expect(graphqlOperationMatches(endpoint, { operationName: 'GetProducts' })).toBe(true);
  });
});

describe('endpointGraphqlOperationName', () => {
  it('returns summary when present', () => {
    const ep = { summary: 'GetProducts', description: '', requestBodySchema: undefined } as any;
    expect(endpointGraphqlOperationName(ep)).toBe('GetProducts');
  });

  it('returns null when no identifying info', () => {
    const ep = { summary: '', description: '', requestBodySchema: undefined } as any;
    expect(endpointGraphqlOperationName(ep)).toBeNull();
  });
});
