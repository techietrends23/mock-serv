import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { MockDefinition, MockEndpoint } from '../types.ts';
import { endpointResponseExample } from '../schema.ts';
import { ensureLeadingSlash, isCollectionPath, normalizePathPattern, sampleFromSchema, sanitizeIdentifier } from '../utils.ts';

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

export class RestRuntime {
  private server?: FastifyInstance;
  private port?: number;

  constructor(private readonly repository: {
    listCrudRows(tableName: string): Array<{ id: string; data: unknown }>;
    seedCrudRow(tableName: string, data: Record<string, unknown>): { id: string; data: unknown };
    deleteCrudRow(tableName: string, id: string): void;
    appendLog(mockId: string | undefined, level: 'info' | 'warn' | 'error', message: string, payload?: unknown): unknown;
  }) {}

  get runningPort(): number | undefined {
    return this.port;
  }

  async start(mock: MockDefinition): Promise<number> {
    const server = Fastify({ logger: false });
    this.server = server;
    const defaultLatency = mock.latencyMs ?? 0;

    for (const endpoint of mock.endpoints) {
      const routePath = normalizePathPattern(ensureLeadingSlash(endpoint.path));
      const method = endpoint.method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

      server.route({
        method,
        url: routePath,
        handler: async (request, reply) => {
          const latency = Math.max(defaultLatency, endpoint.latencyMs ?? 0);
          if (latency > 0) await delay(latency);
          const errorRate = Math.max(mock.errorRate ?? 0, endpoint.errorRate ?? 0);
          if (shouldError(errorRate)) {
            this.repository.appendLog(mock.id, 'warn', `Injected error for ${method} ${routePath}`);
            return reply.code(500).send({ error: 'Injected failure', path: routePath, method });
          }
          const params = request.params as Record<string, string>;
          const query = request.query as Record<string, unknown>;
          const body = (request.body ?? {}) as Record<string, unknown>;
          const tableName = endpoint.tableName || sanitizeIdentifier(`${mock.name}_${endpoint.method}_${endpoint.path}`).toLowerCase();

          if (method === 'GET') {
            const rows = this.repository.listCrudRows(tableName);
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
            const saved = this.repository.seedCrudRow(tableName, { ...body, ...query });
            return reply.code(endpoint.statusCode || 201).send(saved.data);
          }

          if (method === 'PUT' || method === 'PATCH') {
            const id = params.id || Object.values(params)[0] || String((body as Record<string, unknown>).id ?? '');
            const saved = this.repository.seedCrudRow(tableName, { id, ...body, ...query });
            return reply.code(endpoint.statusCode).send(saved.data);
          }

          if (method === 'DELETE') {
            const id = params.id || Object.values(params)[0] || String((body as Record<string, unknown>).id ?? '');
            this.repository.deleteCrudRow(tableName, id);
            return reply.code(204).send();
          }

          const payload = endpoint.responseExample ?? (endpoint.responseSchema ? sampleFromSchema(endpoint.responseSchema) : { ok: true });
          return reply.code(endpoint.statusCode).send(payload);
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
