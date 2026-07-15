import {
  MockService,
  toJsonSchemaLike,
  ensureLeadingSlash,
  inferNameFromMethodAndPath,
  requestGraphqlOperationName,
  bodyContainsRule,
  stableId,
  nowIso
} from '@mock-serv/core';
import type { CapturedCall, MockDefinition, MockEndpoint } from '@mock-serv/core';

export function createMockFromCalls(
  service: MockService,
  calls: CapturedCall[],
  options: { name: string; description: string }
): MockDefinition {
  if (!calls.length) throw new Error('No calls provided.');

  const mockId = stableId('mock');
  const now = nowIso();
  const uniqueCalls = latestCallPerRoute(calls);
  const primary = uniqueCalls[0]!;
  const origin = originFromCall(primary);

  const endpoints = uniqueCalls.map((call, index) => endpointFromCall(call, mockId, index));

  const mock: MockDefinition = {
    id: mockId,
    name: options.name,
    protocol: 'rest',
    description: options.description,
    sourceType: 'har',
    sourceRef: origin,
    status: 'stopped',
    latencyMs: 0,
    errorRate: 0,
    graphqlEnabled: false,
    proxyEnabled: true,
    proxyUrl: origin,
    createdAt: now,
    updatedAt: now,
    endpoints
  };

  return service.saveMock(mock);
}

export function latestCallPerRoute(calls: CapturedCall[]): CapturedCall[] {
  const byRoute = new Map<string, CapturedCall>();
  const ordered = [...calls].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  for (const call of ordered) {
    const path = ensureLeadingSlash(call.path.split('?')[0]);
    const operationName = requestGraphqlOperationName(call.requestBody);
    const key = operationName
      ? `${call.method.toUpperCase()} ${path} ${operationName}`
      : `${call.method.toUpperCase()} ${path}`;
    byRoute.set(key, call);
  }
  return Array.from(byRoute.values());
}

export function endpointFromCall(call: CapturedCall, mockId: string, orderIndex: number): MockEndpoint {
  const path = ensureLeadingSlash(call.path.split('?')[0]);
  const operationName = requestGraphqlOperationName(call.requestBody);
  const queryParams = call.queryString
    ? new URLSearchParams(call.queryString).toString()
      ? Array.from(new URLSearchParams(call.queryString).entries()).map(([name]) => ({
          name,
          required: false,
          schema: { type: 'string' } as any
        }))
      : []
    : [];

  return {
    id: stableId('endpoint'),
    mockId,
    name: operationName || inferNameFromMethodAndPath(call.method, path),
    method: call.method,
    path,
    summary: operationName || undefined,
    description: operationName ? `Match when body contains ${operationName}` : undefined,
    requestHeaders: call.requestHeaders,
    pathParameters: [],
    queryParameters: queryParams,
    requestBodySchema: call.requestBody !== undefined ? toJsonSchemaLike(call.requestBody) : undefined,
    responseSchema: call.responseBody !== undefined ? toJsonSchemaLike(call.responseBody) : undefined,
    responseExample: call.responseBody,
    matchRules: operationName ? [bodyContainsRule(operationName)] : undefined,
    statusCode: call.responseStatus || 200,
    latencyMs: 0,
    errorRate: 0,
    tableName: `captured_${call.method.toLowerCase()}_${sanitizePath(path)}`,
    orderIndex
  };
}

export function originFromCall(call: CapturedCall): string {
  try {
    return new URL(call.url).origin;
  } catch {
    return `https://${call.host}`;
  }
}

export function hostFromSourceRef(sourceRef?: string): string | undefined {
  if (!sourceRef) return undefined;
  try {
    return new URL(sourceRef).host;
  } catch {
    return undefined;
  }
}

export function sanitizePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').toLowerCase();
}
