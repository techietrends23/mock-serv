import type { MockDraft, MockEndpoint } from '../types.ts';
import { inferNameFromMethodAndPath, normalizePathPattern, toJsonSchemaLike } from '../utils.ts';

function parseUrlValue(urlValue: unknown): { path: string; query: Array<{ name: string; required?: boolean }> } {
  if (typeof urlValue === 'string') {
    try {
      const parsed = new URL(urlValue);
      return {
        path: normalizePathPattern(parsed.pathname || '/'),
        query: Array.from(parsed.searchParams.keys()).map((name) => ({ name }))
      };
    } catch {
      return { path: normalizePathPattern(urlValue), query: [] };
    }
  }
  if (urlValue && typeof urlValue === 'object') {
    const typed = urlValue as Record<string, unknown>;
    const rawPath = Array.isArray(typed.path) ? `/${typed.path.join('/')}` : typeof typed.raw === 'string' ? typed.raw : '/';
    const query = Array.isArray(typed.query)
      ? typed.query.map((entry) => {
          const q = entry as Record<string, unknown>;
          return { name: String(q.key ?? 'query'), required: Boolean(q.disabled === false) };
        })
      : [];
    return {
      path: normalizePathPattern(rawPath.includes('://') ? new URL(rawPath).pathname : rawPath),
      query
    };
  }
  return { path: '/', query: [] };
}

export async function parsePostmanCollection(content: string): Promise<MockDraft> {
  const raw = JSON.parse(content) as Record<string, unknown>;
  const items = Array.isArray(raw.item) ? raw.item : [];
  const endpoints: Omit<MockEndpoint, 'id' | 'mockId' | 'tableName' | 'orderIndex'>[] = [];

  const walk = (collectionItems: unknown[]): void => {
    for (const item of collectionItems) {
      const typed = item as Record<string, unknown>;
      if (Array.isArray(typed.item)) {
        walk(typed.item);
        continue;
      }
      const request = typed.request as Record<string, unknown> | undefined;
      if (!request) continue;
      const urlInfo = parseUrlValue(request.url);
      const method = String(request.method || 'GET').toUpperCase();
      const response = Array.isArray(typed.response) ? (typed.response[0] as Record<string, unknown> | undefined) : undefined;
      const responseBody = response?.body
        ? (() => {
            try {
              return JSON.parse(String(response.body));
            } catch {
              return response.body;
            }
          })()
        : undefined;
      const body = request.body as Record<string, unknown> | undefined;
      endpoints.push({
        name: inferNameFromMethodAndPath(method, urlInfo.path || '/'),
        method,
        path: urlInfo.path || '/',
        summary: typeof typed.name === 'string' ? typed.name : undefined,
        description: typeof typed.description === 'string' ? typed.description : undefined,
        requestHeaders: Object.fromEntries(
          Array.isArray(request.header)
            ? (request.header as Array<Record<string, unknown>>).map((header) => [String(header.key ?? ''), String(header.value ?? '')])
            : []
        ),
        pathParameters: [],
        queryParameters: urlInfo.query.map((q) => ({ name: q.name, required: q.required })),
        requestBodySchema: body?.raw ? toJsonSchemaLike(JSON.parse(String(body.raw))) : undefined,
        responseSchema: responseBody !== undefined ? toJsonSchemaLike(responseBody) : undefined,
        responseExample: responseBody,
        statusCode: Number(response?.code ?? 200),
        latencyMs: 0,
        errorRate: 0
      });
    }
  };

  walk(items);

  return {
    name: String(raw.info && typeof raw.info === 'object' ? (raw.info as Record<string, unknown>).name ?? 'postman-mock' : 'postman-mock'),
    protocol: 'rest',
    description: String(raw.info && typeof raw.info === 'object' ? (raw.info as Record<string, unknown>).description ?? '' : ''),
    sourceType: 'postman',
    endpoints
  };
}
