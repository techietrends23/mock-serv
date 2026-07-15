import type { FastifyInstance } from 'fastify';
import { CaptureSessionManager, MockService, toJsonSchemaLike, ensureLeadingSlash, inferNameFromMethodAndPath, stableId, nowIso } from '@mock-serv/core';
import type { CapturedCall, MockDefinition } from '@mock-serv/core';

export function registerCaptureRoutes(server: FastifyInstance, service: MockService): void {
  const captureManager = new CaptureSessionManager(service.repository as any);

  server.addHook('onClose', () => {
    captureManager.cleanup();
  });

  server.post<{ Body: { name: string } }>('/api/capture/sessions', async (request) => {
    const { name } = request.body;
    return captureManager.createSession(name || 'Untitled Session');
  });

  server.get('/api/capture/sessions', async () => {
    return captureManager.listSessions();
  });

  server.get<{ Params: { sessionId: string } }>('/api/capture/sessions/:sessionId', async (request) => {
    const session = captureManager.getSession(request.params.sessionId);
    if (!session) throw new Error('Capture session not found');
    return session;
  });

  server.delete<{ Params: { sessionId: string } }>('/api/capture/sessions/:sessionId', async (request, reply) => {
    captureManager.deleteSession(request.params.sessionId);
    reply.code(204).send();
  });

  server.post<{ Params: { sessionId: string } }>('/api/capture/sessions/:sessionId/start', async (request) => {
    return captureManager.startSession(request.params.sessionId);
  });

  server.post<{ Params: { sessionId: string } }>('/api/capture/sessions/:sessionId/stop', async (request) => {
    return captureManager.stopSession(request.params.sessionId);
  });

  server.post<{ Params: { sessionId: string }; Body: { url: string } }>('/api/capture/sessions/:sessionId/navigate', async (request) => {
    const { url } = request.body;
    if (!url) throw new Error('URL is required');
    await captureManager.navigate(request.params.sessionId, url);
    return { ok: true };
  });

  server.get<{ Params: { sessionId: string } }>('/api/capture/sessions/:sessionId/calls', async (request) => {
    return captureManager.listCalls(request.params.sessionId);
  });

  server.get<{ Params: { sessionId: string; callId: string } }>('/api/capture/sessions/:sessionId/calls/:callId', async (request) => {
    const call = captureManager.getCall(request.params.callId);
    if (!call) throw new Error('Captured call not found');
    return call;
  });

  server.delete<{ Params: { sessionId: string; callId: string } }>(
    '/api/capture/sessions/:sessionId/calls/:callId',
    async (request, reply) => {
      const call = captureManager.getCall(request.params.callId);
      if (!call || call.sessionId !== request.params.sessionId) throw new Error('Captured call not found');
      captureManager.deleteCall(request.params.callId);
      reply.code(204).send();
    }
  );

  server.post<{ Params: { sessionId: string; callId: string }; Body: { name?: string; description?: string } }>(
    '/api/capture/sessions/:sessionId/calls/:callId/mock',
    async (request) => {
      const call = captureManager.getCall(request.params.callId);
      if (!call) throw new Error('Captured call not found');

      const mockName = request.body.name || `captured_${call.method.toLowerCase()}_${call.path.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const mockId = stableId('mock');
      const now = nowIso();
      const endpointId = stableId('endpoint');
      const path = ensureLeadingSlash(call.path.split('?')[0]);
      const tableName = `captured_${call.method.toLowerCase()}_${sanitizePath(path)}`;

      const queryParams = call.queryString
        ? new URLSearchParams(call.queryString).toString()
          ? Array.from(new URLSearchParams(call.queryString).entries()).map(([name]) => ({
              name,
              required: false,
              schema: { type: 'string' } as any
            }))
          : []
        : [];

      const requestBodySchema = call.requestBody !== undefined
        ? toJsonSchemaLike(call.requestBody)
        : undefined;

      const responseSchema = call.responseBody !== undefined
        ? toJsonSchemaLike(call.responseBody)
        : undefined;

      const endpoint: any = {
        id: endpointId,
        mockId,
        name: inferNameFromMethodAndPath(call.method, path),
        method: call.method,
        path,
        requestHeaders: call.requestHeaders,
        pathParameters: [],
        queryParameters: queryParams,
        requestBodySchema,
        responseSchema,
        responseExample: call.responseBody,
        statusCode: call.responseStatus || 200,
        latencyMs: 0,
        errorRate: 0,
        tableName,
        orderIndex: 0
      };

      const mock: MockDefinition = {
        id: mockId,
        name: mockName,
        protocol: 'rest',
        description: request.body.description || `Created from captured ${call.method} ${path}`,
        sourceType: 'har',
        sourceRef: call.url,
        status: 'stopped',
        latencyMs: 0,
        errorRate: 0,
        graphqlEnabled: false,
        createdAt: now,
        updatedAt: now,
        endpoints: [endpoint]
      };

      return service.saveMock(mock);
    }
  );
}

function sanitizePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').toLowerCase();
}
