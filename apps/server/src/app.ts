import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MockDefinition, MockEndpoint } from '@mock-serv/core';
import { MockService } from '@mock-serv/core';
import { registerCaptureRoutes } from './capture-routes.ts';

export interface BuildServerOptions {
  dataDir?: string;
  uiDistDir?: string;
  logger?: boolean;
}

function defaultDataDir(): string {
  return path.resolve(process.cwd(), '.mock-serv-data');
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.html':
      return 'text/html; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function resolveUiFile(uiDistDir: string, requestPath: string): string {
  const relativePath = requestPath.replace(/^\/+/, '');
  const candidate = path.resolve(uiDistDir, relativePath || 'index.html');
  if (candidate.startsWith(uiDistDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }
  return path.join(uiDistDir, 'index.html');
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const dataDir = options.dataDir ?? defaultDataDir();
  const uiDistDir = options.uiDistDir ? path.resolve(options.uiDistDir) : undefined;
  const service = new MockService(dataDir);
  const server = Fastify({
    logger: options.logger ?? false
  });

  server.setErrorHandler((error, _request, reply) => {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    const message = error instanceof Error ? error.message : 'Unexpected server error';
    reply.code(statusCode).send({ message });
  });

  server.get('/api/health', async () => ({
    ok: true,
    dataDir
  }));

  server.get('/api/mocks', async () => service.listMocks());

  server.get<{ Querystring: { mockId?: string } }>('/api/logs', async (request) => service.listLogs(request.query.mockId));

  server.post<{ Body: { sourceType: 'openapi' | 'curl' | 'postman' | 'har'; content: string } }>('/api/import/parse', async (request) =>
    service.parseImport(request.body.sourceType, request.body.content)
  );

  server.post<{
    Body: {
      sourceType: 'openapi' | 'curl' | 'postman' | 'har';
      content: string;
      name: string;
      protocol?: 'rest' | 'graphql';
      description?: string;
    };
  }>('/api/import', async (request) => service.importMock(request.body));

  server.put<{ Params: { mockId: string }; Body: MockDefinition }>('/api/mocks/:mockId', async (request) => {
    if (request.body.id !== request.params.mockId) {
      throw new Error('Mock id mismatch between URL and payload.');
    }
    return service.saveMock(request.body);
  });

  server.patch<{ Params: { mockId: string }; Body: Partial<MockDefinition> }>('/api/mocks/:mockId', async (request) =>
    service.updateMock(request.params.mockId, request.body)
  );

  server.delete<{ Params: { mockId: string } }>('/api/mocks/:mockId', async (request, reply) => {
    service.deleteMock(request.params.mockId);
    reply.code(204).send();
  });

  server.post<{ Params: { mockId: string } }>('/api/mocks/:mockId/start', async (request) => service.startMock(request.params.mockId));

  server.post<{ Params: { mockId: string } }>('/api/mocks/:mockId/stop', async (request) => (await service.stopMock(request.params.mockId)) ?? null);

  server.post<{ Params: { mockId: string } }>('/api/mocks/:mockId/sync', async (request) => service.syncMock(request.params.mockId));

  server.post<{
    Params: { mockId: string };
    Body: Partial<MockEndpoint> & Pick<MockEndpoint, 'method' | 'path' | 'name'>;
  }>('/api/mocks/:mockId/endpoints', async (request) => service.upsertEndpoint(request.params.mockId, request.body));

  server.delete<{ Params: { mockId: string; endpointId: string } }>('/api/mocks/:mockId/endpoints/:endpointId', async (request) =>
    service.deleteEndpoint(request.params.mockId, request.params.endpointId)
  );

  server.get<{ Params: { mockId: string; endpointId: string } }>('/api/mocks/:mockId/endpoints/:endpointId/rows', async (request) =>
    service.listRows(request.params.mockId, request.params.endpointId)
  );

  server.put<{ Params: { mockId: string; endpointId: string }; Body: { rows: Record<string, unknown>[] } }>(
    '/api/mocks/:mockId/endpoints/:endpointId/rows',
    async (request) => service.seedRows(request.params.mockId, request.params.endpointId, request.body.rows)
  );

  registerCaptureRoutes(server, service);

  if (uiDistDir && fs.existsSync(uiDistDir)) {
    server.get('/', async (_request, reply) => {
      const indexPath = path.join(uiDistDir, 'index.html');
      reply.type('text/html; charset=utf-8').send(fs.readFileSync(indexPath, 'utf8'));
    });

    server.get<{ Params: { '*': string } }>('/*', async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.callNotFound();
      }
      const filePath = resolveUiFile(uiDistDir, request.params['*'] ?? '');
      reply.type(contentTypeFor(filePath)).send(fs.readFileSync(filePath));
    });
  }

  return server;
}
