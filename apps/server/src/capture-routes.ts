import type { FastifyInstance } from 'fastify';
import {
  CaptureSessionManager,
  MockService,
  ensureLeadingSlash
} from '@mock-serv/core';
import type { CapturedCall, MockDefinition } from '@mock-serv/core';
import {
  createMockFromCalls,
  hostFromSourceRef,
  sanitizePath
} from './capture-mock-factory.ts';

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

  server.post<{ Params: { sessionId: string; callId: string }; Body: { name?: string; description?: string; autoWire?: boolean } }>(
    '/api/capture/sessions/:sessionId/calls/:callId/mock',
    async (request) => {
      const call = captureManager.getCall(request.params.callId);
      if (!call) throw new Error('Captured call not found');

      const mockName = request.body.name || `captured_${call.method.toLowerCase()}_${call.path.replace(/[^a-zA-Z0-9]/g, '_')}`;
      let mock = createMockFromCalls(service, [call], {
        name: mockName,
        description: request.body.description || `Created from captured ${call.method} ${ensureLeadingSlash(call.path.split('?')[0])} (${call.host})`
      });

      if (request.body.autoWire !== false) {
        mock = await service.startMock(mock.id);
      }

      return mock;
    }
  );

  server.post<{
    Params: { sessionId: string };
    Body: { domains: string[]; autoWire?: boolean };
  }>('/api/capture/sessions/:sessionId/mocks-from-domains', async (request) => {
    const domains = Array.from(new Set((request.body.domains ?? []).map((domain) => domain.trim()).filter(Boolean)));
    if (!domains.length) throw new Error('Select at least one domain.');

    const calls = captureManager
      .listCalls(request.params.sessionId)
      .filter((call) => domains.includes(call.host));
    if (!calls.length) throw new Error('No captured calls found for the selected domains.');

    const byHost = new Map<string, CapturedCall[]>();
    for (const call of calls) {
      const group = byHost.get(call.host) ?? [];
      group.push(call);
      byHost.set(call.host, group);
    }

    const mocks: MockDefinition[] = [];
    for (const domain of domains) {
      const hostCalls = byHost.get(domain);
      if (!hostCalls?.length) continue;
      let mock = createMockFromCalls(service, hostCalls, {
        name: `mock_${sanitizePath(domain)}`,
        description: `Auto-created from domain ${domain} (${hostCalls.length} captured call${hostCalls.length === 1 ? '' : 's'})`
      });
      if (request.body.autoWire !== false) {
        mock = await service.startMock(mock.id);
      }
      mocks.push(mock);
    }

    return {
      mocks,
      domains: mocks
        .map((mock) => hostFromSourceRef(mock.sourceRef))
        .filter((host): host is string => Boolean(host)),
      autoWired: request.body.autoWire !== false
    };
  });
}
