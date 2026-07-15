import type { MockEndpoint } from './types.ts';

export function parseGraphqlRequestBody(body: unknown): Record<string, unknown> | null {
  let value: unknown = body;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function requestGraphqlOperationName(body: unknown): string | null {
  const parsed = parseGraphqlRequestBody(body);
  if (!parsed) return null;
  if (typeof parsed.operationName === 'string' && parsed.operationName.trim()) {
    return parsed.operationName.trim();
  }
  return null;
}

export function endpointGraphqlOperationName(endpoint: Pick<MockEndpoint, 'summary' | 'description' | 'requestBodySchema'>): string | null {
  if (endpoint.summary?.trim()) return endpoint.summary.trim();

  const schema = endpoint.requestBodySchema as
    | { example?: unknown; properties?: Record<string, { example?: unknown }> }
    | undefined;
  const example = schema?.example;
  if (typeof example === 'string') {
    return requestGraphqlOperationName(example);
  }
  if (example && typeof example === 'object') {
    return requestGraphqlOperationName(example);
  }
  const fromProperty = schema?.properties?.operationName?.example;
  if (typeof fromProperty === 'string' && fromProperty.trim()) return fromProperty.trim();

  const fromDescription = endpoint.description?.match(/operation(?:Name)?\s*[:=]\s*([A-Za-z0-9_]+)/i);
  return fromDescription?.[1] ?? null;
}

export function isGraphqlPath(path: string): boolean {
  return /graphql/i.test(path);
}

/** When an endpoint is bound to a GraphQL operation, only that operation should be mocked. */
export function graphqlOperationMatches(endpoint: MockEndpoint, requestBody: unknown): boolean {
  if (!isGraphqlPath(endpoint.path)) return true;
  const expected = endpointGraphqlOperationName(endpoint);
  if (!expected) return true;
  const actual = requestGraphqlOperationName(requestBody);
  return Boolean(actual && actual === expected);
}
