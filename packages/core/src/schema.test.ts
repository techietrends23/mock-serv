import { describe, expect, it } from 'vitest';
import { endpointResponseExample, buildEndpointArtifacts } from './schema.ts';
import type { MockDefinition, MockEndpoint } from './types.ts';

describe('endpointResponseExample', () => {
  it('returns responseExample when set', () => {
    const result = endpointResponseExample({
      responseExample: { id: 1, name: 'test' },
      responseSchema: { type: 'object' }
    } as any);
    expect(result).toEqual({ id: 1, name: 'test' });
  });

  it('samples from schema when no example', () => {
    const result = endpointResponseExample({
      responseExample: undefined,
      responseSchema: { type: 'string' }
    } as any);
    expect(result).toBe('string');
  });

  it('returns fallback when neither example nor schema', () => {
    const result = endpointResponseExample({
      responseExample: undefined,
      responseSchema: undefined
    } as any);
    expect(result).toEqual({ ok: true });
  });
});

describe('buildEndpointArtifacts', () => {
  function makeMock(endpoints: MockEndpoint[]): MockDefinition {
    return {
      id: 'mock1',
      name: 'test',
      protocol: 'graphql',
      sourceType: 'har',
      status: 'stopped',
      latencyMs: 0,
      errorRate: 0,
      graphqlEnabled: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      endpoints
    };
  }

  function makeEndpoint(overrides: Partial<MockEndpoint>): MockEndpoint {
    return {
      id: 'ep1',
      mockId: 'mock1',
      name: 'test',
      method: 'GET',
      path: '/users',
      requestHeaders: {},
      pathParameters: [],
      queryParameters: [],
      statusCode: 200,
      latencyMs: 0,
      errorRate: 0,
      tableName: 'test_users',
      orderIndex: 0,
      ...overrides
    };
  }

  it('generates Query type for GET endpoints', () => {
    const mock = makeMock([makeEndpoint({ name: 'listUsers', method: 'GET', path: '/users' })]);
    const artifacts = buildEndpointArtifacts(mock);
    expect(artifacts.typeDefs).toContain('type Query');
    expect(artifacts.typeDefs).toContain('listUsers');
    expect(artifacts.fields).toHaveLength(1);
    expect(artifacts.fields[0].kind).toBe('query');
  });

  it('generates Mutation type for non-GET endpoints', () => {
    const mock = makeMock([makeEndpoint({ name: 'createUser', method: 'POST', path: '/users' })]);
    const artifacts = buildEndpointArtifacts(mock);
    expect(artifacts.typeDefs).toContain('type Mutation');
    expect(artifacts.typeDefs).toContain('createUser_post');
    expect(artifacts.fields).toHaveLength(1);
    expect(artifacts.fields[0].kind).toBe('mutation');
  });

  it('marks collection GET paths as list', () => {
    const mock = makeMock([makeEndpoint({ method: 'GET', path: '/users' })]);
    const artifacts = buildEndpointArtifacts(mock);
    expect(artifacts.fields[0].isList).toBe(true);
  });

  it('marks singleton GET paths as non-list', () => {
    const mock = makeMock([makeEndpoint({ method: 'GET', path: '/users/{id}' })]);
    const artifacts = buildEndpointArtifacts(mock);
    expect(artifacts.fields[0].isList).toBe(false);
  });

  it('includes path parameters as GraphQL args', () => {
    const mock = makeMock([
      makeEndpoint({
        method: 'GET',
        path: '/users/{id}',
        pathParameters: [{ name: 'id', required: true }]
      })
    ]);
    const artifacts = buildEndpointArtifacts(mock);
    expect(artifacts.typeDefs).toContain('id: ID!');
  });

  it('generates resolvers object', () => {
    const mock = makeMock([makeEndpoint({ name: 'listUsers', method: 'GET', path: '/users' })]);
    const artifacts = buildEndpointArtifacts(mock);
    const queryResolvers = artifacts.resolvers.Query as Record<string, unknown>;
    expect(queryResolvers).toHaveProperty('listUsers');
    expect(typeof queryResolvers.listUsers).toBe('function');
  });

  it('returns resolvers for mutation endpoints', () => {
    const mock = makeMock([makeEndpoint({ name: 'createUser', method: 'POST', path: '/users' })]);
    const artifacts = buildEndpointArtifacts(mock);
    const mutationResolvers = artifacts.resolvers.Mutation as Record<string, unknown>;
    expect(mutationResolvers).toHaveProperty('createUser_post');
    expect(typeof mutationResolvers.createUser_post).toBe('function');
  });

  it('handles empty endpoints gracefully', () => {
    const mock = makeMock([]);
    const artifacts = buildEndpointArtifacts(mock);
    expect(artifacts.typeDefs).toContain('Query');
    expect(artifacts.typeDefs).toContain('Mutation');
    expect(artifacts.fields).toHaveLength(0);
  });
});
