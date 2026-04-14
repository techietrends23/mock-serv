import type { MockDraft, MockEndpoint } from '../types.ts';
import { inferNameFromMethodAndPath, normalizePathPattern, toJsonSchemaLike } from '../utils.ts';

function safeParseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function parseHarDocument(content: string): Promise<MockDraft> {
  const raw = JSON.parse(content) as Record<string, unknown>;
  const log = raw.log as Record<string, unknown> | undefined;
  const entries = Array.isArray(log?.entries) ? log?.entries : [];
  const endpoints: Omit<MockEndpoint, 'id' | 'mockId' | 'tableName' | 'orderIndex'>[] = [];

  for (const entry of entries) {
    const typed = entry as Record<string, unknown>;
    const request = (typed.request as Record<string, unknown>) || {};
    const response = (typed.response as Record<string, unknown>) || {};
    const url = typeof request.url === 'string' ? request.url : request.url && typeof request.url === 'object' ? (request.url as Record<string, unknown>).path : undefined;
    const parsedUrl = typeof url === 'string' ? new URL(url, 'http://localhost') : undefined;
    const path = normalizePathPattern(parsedUrl?.pathname || '/');
    const responseBody = safeParseJson(typeof response.content === 'object' ? String((response.content as Record<string, unknown>).text ?? '') : undefined);
    endpoints.push({
      name: inferNameFromMethodAndPath(String(request.method ?? 'GET'), path),
      method: String(request.method ?? 'GET').toUpperCase(),
      path,
      summary: typeof typed.comment === 'string' ? typed.comment : undefined,
      requestHeaders: Object.fromEntries(
        Array.isArray(request.headers)
          ? (request.headers as Array<Record<string, unknown>>).map((header) => [String(header.name ?? header.key ?? ''), String(header.value ?? '')])
          : []
      ),
      pathParameters: [],
      queryParameters: [],
      requestBodySchema: toJsonSchemaLike(safeParseJson(typeof request.postData === 'object' ? String((request.postData as Record<string, unknown>).text ?? '') : undefined)),
      responseSchema: responseBody !== undefined ? toJsonSchemaLike(responseBody) : undefined,
      responseExample: responseBody,
      statusCode: Number(response.status ?? 200),
      latencyMs: 0,
      errorRate: 0
    });
  }

  return {
    name: 'har-mock',
    protocol: 'rest',
    sourceType: 'har',
    endpoints
  };
}
