import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JsonSchemaLike, MockDefinition, MockEndpoint } from '../types.ts';
import { endpointResponseExample } from '../schema.ts';
import { matchesAllRules } from '../match-rules.ts';
import { ensureLeadingSlash, isCollectionPath, normalizePathPattern, sampleFromSchema, sanitizeIdentifier } from '../utils.ts';
import { renderDeep, resolveSequence, buildRequestContext } from '../response-engine.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathParamsFromEndpoint(endpoint: MockEndpoint): string[] {
  const matches = endpoint.path.match(/:([A-Za-z0-9_]+)/g) ?? [];
  return matches.map((match) => match.slice(1));
}

function shouldError(rate: number): boolean {
  return rate > 0 && Math.random() < rate;
}

function applyCorsHeaders(request: FastifyRequest, reply: FastifyReply): void {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '*';
  const requestedHeaders = request.headers['access-control-request-headers'];
  reply.header('Access-Control-Allow-Origin', origin);
  reply.header('Vary', 'Origin');
  reply.header('Access-Control-Allow-Credentials', 'true');
  reply.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
  reply.header(
    'Access-Control-Allow-Headers',
    typeof requestedHeaders === 'string' && requestedHeaders
      ? requestedHeaders
      : 'content-type,authorization,apollographql-client-name,apollographql-client-version,x-apollo-operation-name,x-requested-with,accept'
  );
  reply.header('Access-Control-Expose-Headers', '*');
  reply.header('Access-Control-Max-Age', '86400');
}

function proxyBaseUrl(mock: MockDefinition): string | undefined {
  const raw = mock.proxyUrl || mock.sourceRef;
  if (!raw?.startsWith('http')) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

function pathMatches(endpointPath: string, requestPath: string): boolean {
  return normalizePathPattern(ensureLeadingSlash(endpointPath)) === normalizePathPattern(ensureLeadingSlash(requestPath));
}

function findMatchingEndpoint(
  endpoints: MockEndpoint[],
  request: {
    method: string;
    url: string;
    path: string;
    queryString?: string;
    headers?: Record<string, string | string[] | undefined>;
    body?: unknown;
  }
): MockEndpoint | undefined {
  const method = request.method.toUpperCase();
  return endpoints
    .filter((endpoint) => endpoint.method.toUpperCase() === method && pathMatches(endpoint.path, request.path))
    .sort((left, right) => left.orderIndex - right.orderIndex)
    .find((endpoint) =>
      matchesAllRules(endpoint.matchRules, {
        method,
        url: request.url,
        path: request.path,
        queryString: request.queryString,
        headers: request.headers,
        body: request.body
      })
    );
}

async function proxyRequest(mock: MockDefinition, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const base = proxyBaseUrl(mock);
  if (!base) {
    return reply.code(404).send({ error: 'No mock rule matched and proxy URL is not configured.' });
  }

  const incomingUrl = new URL(request.url, 'http://127.0.0.1');
  const target = new URL(incomingUrl.pathname + incomingUrl.search, base);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (value == null) continue;
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'content-length' || lower === 'connection') continue;
    headers[key] = Array.isArray(value) ? value.join(',') : String(value);
  }

  const method = request.method.toUpperCase();
  const hasBody = !['GET', 'HEAD'].includes(method);
  const upstream = await fetch(target, {
    method,
    headers,
    body: hasBody ? (typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {})) : undefined
  });

  const text = await upstream.text();
  const contentType = upstream.headers.get('content-type');
  if (contentType) reply.header('content-type', contentType);
  return reply.code(upstream.status).send(text);
}

function validateAgainstSchema(body: unknown, schema: JsonSchemaLike | undefined): string | null {
  if (!schema) return null;
  const typed = schema as Record<string, unknown>;
  if (typed.type === 'object' && typed.required && Array.isArray(typed.required)) {
    if (!body || typeof body !== 'object') return 'Request body must be an object';
    const obj = body as Record<string, unknown>;
    for (const field of typed.required) {
      if (!(field in obj) || obj[field] === undefined) {
        return `Missing required field: ${field}`;
      }
    }
  }
  return null;
}

async function handleMockedEndpoint(
  mock: MockDefinition,
  endpoint: MockEndpoint,
  request: FastifyRequest,
  reply: FastifyReply,
  repository: RestRuntime['repository']
): Promise<unknown> {
  // Request body validation
  const validationError = validateAgainstSchema(request.body, endpoint.requestBodySchema as JsonSchemaLike | undefined);
  if (validationError) {
    repository.appendLog(mock.id, 'warn', `Validation failed for ${endpoint.method} ${endpoint.path}: ${validationError}`);
    return reply.code(400).send({ error: 'Validation failed', detail: validationError });
  }

  const latency = Math.max(
    mock.latencyMs ?? 0,
    endpoint.latencyMs ?? 0,
    endpoint.responseSequence?.[0]?.latencyMs ?? 0
  );
  if (latency > 0) await delay(latency);

  const errorRate = Math.max(mock.errorRate ?? 0, endpoint.errorRate ?? 0);
  if (shouldError(errorRate)) {
    repository.appendLog(mock.id, 'warn', `Injected error for ${endpoint.method} ${endpoint.path}`);
    return reply.code(500).send({ error: 'Injected failure', path: endpoint.path, method: endpoint.method });
  }

  const method = endpoint.method.toUpperCase();
  const params = request.params as Record<string, string>;
  const query = request.query as Record<string, unknown>;
  const body = (request.body ?? {}) as Record<string, unknown>;
  const tableName = endpoint.tableName || sanitizeIdentifier(`${mock.name}_${endpoint.method}_${endpoint.path}`).toLowerCase();
  const headers = request.headers as Record<string, string | string[] | undefined>;
  const flatHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    flatHeaders[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
  }
  const flatQuery: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    flatQuery[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
  }

  const ctx = buildRequestContext({
    body, query: flatQuery, params, headers: flatHeaders, method, path: request.url
  });

  // Response sequence support
  const seq = resolveSequence(endpoint);
  if (seq) {
    const rendered = renderDeep(seq.body, ctx);
    return reply.code(seq.statusCode).send(rendered);
  }

  // Response template support
  if (endpoint.responseTemplate) {
    const rendered = renderDeep(endpoint.responseExample ?? endpointResponseExample(endpoint), ctx);
    return reply.code(endpoint.statusCode || 200).send(rendered);
  }

  // Canned response (GraphQL captures, static mocks, etc.)
  if (endpoint.responseExample !== undefined && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'GET')) {
    if (method === 'GET') {
      const rows = repository.listCrudRows(tableName);
      const hasIdParam = pathParamsFromEndpoint(endpoint).length > 0 || !isCollectionPath(endpoint.path);
      if (hasIdParam) {
        const id = params.id || Object.values(params)[0];
        const row = rows.find((candidate) => candidate.id === id);
        return reply.code(endpoint.statusCode).send(row?.data ?? endpointResponseExample(endpoint));
      }
      if (rows.length) return reply.code(endpoint.statusCode).send(rows.map((row) => row.data));
    }
    return reply.code(endpoint.statusCode || 200).send(endpointResponseExample(endpoint));
  }

  if (method === 'GET') {
    const rows = repository.listCrudRows(tableName);
    const hasIdParam = pathParamsFromEndpoint(endpoint).length > 0 || !isCollectionPath(endpoint.path);
    if (hasIdParam) {
      const id = params.id || Object.values(params)[0];
      const row = rows.find((candidate) => candidate.id === id);
      const payload = row?.data ?? endpointResponseExample(endpoint);
      return reply.code(endpoint.statusCode).send(payload);
    }
    const payload = rows.length ? rows.map((row) => row.data) : endpointResponseExample(endpoint);
    return reply.code(endpoint.statusCode).send(payload);
  }

  if (method === 'POST') {
    const saved = repository.seedCrudRow(tableName, { ...body, ...query });
    return reply.code(endpoint.statusCode || 201).send(saved.data);
  }

  if (method === 'PUT' || method === 'PATCH') {
    const id = params.id || Object.values(params)[0] || String(body.id ?? '');
    const saved = repository.seedCrudRow(tableName, { id, ...body, ...query });
    return reply.code(endpoint.statusCode).send(saved.data);
  }

  if (method === 'DELETE') {
    const id = params.id || Object.values(params)[0] || String(body.id ?? '');
    repository.deleteCrudRow(tableName, id);
    return reply.code(204).send();
  }

  const payload = endpoint.responseExample ?? (endpoint.responseSchema ? sampleFromSchema(endpoint.responseSchema) : { ok: true });
  return reply.code(endpoint.statusCode).send(payload);
}

export class RestRuntime {
  private server?: FastifyInstance;
  private port?: number;

  constructor(
    private readonly repository: {
      listCrudRows(tableName: string): Array<{ id: string; data: unknown }>;
      seedCrudRow(tableName: string, data: Record<string, unknown>): { id: string; data: unknown };
      deleteCrudRow(tableName: string, id: string): void;
      appendLog(mockId: string | undefined, level: 'info' | 'warn' | 'error', message: string, payload?: unknown): unknown;
    }
  ) {}

  get runningPort(): number | undefined {
    return this.port;
  }

  async start(mock: MockDefinition): Promise<number> {
    const server = Fastify({ logger: false });
    this.server = server;

    server.addHook('onRequest', async (request, reply) => {
      applyCorsHeaders(request, reply);
    });

    // OPTIONS preflight for any path
    server.route({
      method: 'OPTIONS',
      url: '/*',
      handler: async (_request, reply) => reply.code(204).send()
    });

    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
    for (const method of methods) {
      server.route({
        method,
        url: '/*',
        handler: async (request, reply) => {
          const incomingUrl = new URL(request.url, 'http://127.0.0.1');
          const match = findMatchingEndpoint(mock.endpoints, {
            method,
            url: request.url,
            path: incomingUrl.pathname,
            queryString: incomingUrl.search,
            headers: request.headers as Record<string, string | string[] | undefined>,
            body: request.body
          });

          if (match) {
            return handleMockedEndpoint(mock, match, request, reply, this.repository);
          }

          if (mock.proxyEnabled) {
            this.repository.appendLog(mock.id, 'info', `Proxy ${method} ${incomingUrl.pathname}`);
            return proxyRequest(mock, request, reply);
          }

          return reply.code(404).send({
            error: 'No mock matched this request.',
            hint: 'Add match rules (e.g. body contains operationName) or enable proxy mode.'
          });
        }
      });
    }

    await server.listen({ port: mock.port ?? 0, host: '127.0.0.1' });
    const address = server.server.address();
    const port = typeof address === 'object' && address ? address.port : mock.port ?? 0;
    this.port = port;
    return port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await this.server.close();
    this.server = undefined;
    this.port = undefined;
  }
}
