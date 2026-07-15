import http from 'node:http';
import { createYoga, createSchema } from 'graphql-yoga';
import type { MockDefinition } from '../types.ts';
import { buildEndpointArtifacts, JSONScalar } from '../schema.ts';
import { sampleFromSchema } from '../utils.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GraphQLRuntime {
  private server?: http.Server;
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
    const artifacts = buildEndpointArtifacts(mock);
    const queryFields = artifacts.fields.filter((field) => field.kind === 'query');
    const mutationFields = artifacts.fields.filter((field) => field.kind === 'mutation');
    const yoga = createYoga({
      schema: createSchema({
        typeDefs: artifacts.typeDefs,
        resolvers: {
          JSON: JSONScalar,
          Query: Object.fromEntries(
            queryFields.map((field) => {
              const endpoint = mock.endpoints.find((item) => item.id === field.endpointId)!;
              return [
                field.name,
                async (_: unknown, args: Record<string, string>) => {
                  if (mock.latencyMs) await delay(mock.latencyMs);
                  const rows = this.repository.listCrudRows(endpoint.tableName);
                  if (field.isList) {
                    return rows.map((row) => row.data);
                  }
                  const id = args.id || Object.values(args)[0] || '';
                  const row = rows.find((candidate) => candidate.id === id);
                  return row?.data ?? sampleFromSchema(endpoint.responseSchema ?? { type: 'object' });
                }
              ];
            })
          ),
          Mutation: Object.fromEntries(
            mutationFields.map((field) => {
              const endpoint = mock.endpoints.find((item) => item.id === field.endpointId)!;
              return [
                field.name,
                async (_: unknown, args: Record<string, unknown>) => {
                  if (mock.latencyMs) await delay(mock.latencyMs);
                  const input = (args.input ?? {}) as Record<string, unknown>;
                  const id = String(args.id ?? input.id ?? '');
                  if (endpoint.method.toUpperCase() === 'DELETE') {
                    this.repository.deleteCrudRow(endpoint.tableName, id);
                    return { ok: true };
                  }
                  const saved = this.repository.seedCrudRow(endpoint.tableName, { id, ...input });
                  return saved.data;
                }
              ];
            })
          )
        }
      }),
      graphqlEndpoint: '/graphql',
      cors: {
        origin: '*',
        credentials: true,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: [
          'content-type',
          'authorization',
          'apollographql-client-name',
          'apollographql-client-version',
          'x-apollo-operation-name',
          'x-requested-with',
          'accept'
        ]
      }
    });

    const server = http.createServer(yoga);
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(mock.port ?? 0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : mock.port ?? 0;
    this.port = port;
    return port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.server = undefined;
    this.port = undefined;
  }
}
