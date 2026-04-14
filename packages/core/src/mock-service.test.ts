import { describe, expect, it } from 'vitest';
import type { MockDefinition, MockEndpoint } from './types.ts';
import { MockService } from './index.ts';
import { nowIso, toTableName } from './utils.ts';

class InMemoryRepository {
  private mocks = new Map<string, MockDefinition>();
  private endpoints = new Map<string, MockEndpoint[]>();
  private logs: Array<{ mockId?: string; level: 'info' | 'warn' | 'error'; message: string; createdAt: string }> = [];

  saveMock(input: Omit<MockDefinition, 'createdAt' | 'updatedAt' | 'endpoints'> & { createdAt?: string; updatedAt?: string }): MockDefinition {
    const existing = this.mocks.get(input.id);
    const saved: MockDefinition = {
      ...existing,
      ...input,
      createdAt: input.createdAt ?? existing?.createdAt ?? nowIso(),
      updatedAt: input.updatedAt ?? nowIso(),
      endpoints: this.endpoints.get(input.id) ?? []
    };
    this.mocks.set(saved.id, saved);
    return this.getMock(saved.id)!;
  }

  saveEndpoints(
    mockId: string,
    mockName: string,
    endpoints: Array<Omit<MockEndpoint, 'id' | 'mockId' | 'orderIndex'> & { tableName?: string }>
  ): MockEndpoint[] {
    const saved = endpoints.map((endpoint, index) => ({
      ...endpoint,
      id: `endpoint_${index + 1}`,
      mockId,
      tableName: endpoint.tableName ?? toTableName(mockName, endpoint.path, endpoint.method),
      orderIndex: index
    }));
    this.endpoints.set(mockId, saved);
    const mock = this.mocks.get(mockId);
    if (mock) {
      this.mocks.set(mockId, { ...mock, endpoints: saved });
    }
    return saved;
  }

  listMocks(): MockDefinition[] {
    return [...this.mocks.values()].map((mock) => this.getMock(mock.id)!);
  }

  getMock(id: string): MockDefinition | undefined {
    const mock = this.mocks.get(id);
    if (!mock) return undefined;
    return { ...mock, endpoints: this.listEndpointsByMockId(id) };
  }

  deleteMock(id: string): void {
    this.mocks.delete(id);
    this.endpoints.delete(id);
  }

  listEndpointsByMockId(mockId: string): MockEndpoint[] {
    return [...(this.endpoints.get(mockId) ?? [])];
  }

  upsertEndpoint(mockId: string, mockName: string, endpoint: Partial<MockEndpoint> & Pick<MockEndpoint, 'method' | 'path' | 'name'>): MockEndpoint {
    const current = this.listEndpointsByMockId(mockId);
    const saved: MockEndpoint = {
      id: endpoint.id ?? `endpoint_${current.length + 1}`,
      mockId,
      name: endpoint.name,
      method: endpoint.method,
      path: endpoint.path,
      requestHeaders: endpoint.requestHeaders ?? {},
      pathParameters: endpoint.pathParameters ?? [],
      queryParameters: endpoint.queryParameters ?? [],
      requestBodySchema: endpoint.requestBodySchema,
      responseSchema: endpoint.responseSchema,
      responseExample: endpoint.responseExample,
      statusCode: endpoint.statusCode ?? 200,
      latencyMs: endpoint.latencyMs ?? 0,
      errorRate: endpoint.errorRate ?? 0,
      tableName: endpoint.tableName ?? toTableName(mockName, endpoint.path, endpoint.method),
      orderIndex: endpoint.orderIndex ?? current.length
    };
    this.endpoints.set(
      mockId,
      [...current.filter((item) => item.id !== saved.id), saved].sort((left, right) => left.orderIndex - right.orderIndex)
    );
    return saved;
  }

  deleteEndpoint(endpointId: string): void {
    for (const [mockId, endpoints] of this.endpoints.entries()) {
      this.endpoints.set(
        mockId,
        endpoints.filter((endpoint) => endpoint.id !== endpointId)
      );
    }
  }

  listLogs(mockId?: string) {
    return mockId ? this.logs.filter((entry) => entry.mockId === mockId) : [...this.logs];
  }

  listRowsByEndpointId(): Array<{ id: string; data: unknown; createdAt: string; updatedAt: string }> {
    return [];
  }

  replaceRowsForEndpoint(): void {}

  appendLog(mockId: string | undefined, level: 'info' | 'warn' | 'error', message: string) {
    this.logs.push({ mockId, level, message, createdAt: nowIso() });
  }
}

class InMemoryRuntime {
  private states = new Map<string, { status: MockDefinition['status']; port?: number }>();

  constructor(private readonly repository: InMemoryRepository) {}

  async start(mockId: string): Promise<MockDefinition> {
    const mock = this.repository.getMock(mockId);
    if (!mock) throw new Error(`Mock not found: ${mockId}`);
    const port = 4100;
    this.states.set(mockId, { status: 'running', port });
    const { endpoints: _endpoints, ...persisted } = mock;
    return this.repository.saveMock({ ...persisted, port, status: 'running' });
  }

  async stop(mockId: string): Promise<MockDefinition | undefined> {
    const mock = this.repository.getMock(mockId);
    if (!mock) return undefined;
    this.states.set(mockId, { status: 'stopped', port: undefined });
    const { endpoints: _endpoints, ...persisted } = mock;
    return this.repository.saveMock({ ...persisted, port: undefined, status: 'stopped' });
  }

  async sync(mockId: string): Promise<MockDefinition> {
    const mock = this.repository.getMock(mockId);
    if (!mock) throw new Error(`Mock not found: ${mockId}`);
    return mock;
  }

  listRuntimeStates(): unknown[] {
    return [...this.states.entries()];
  }

  getRuntime(mockId: string): { status: MockDefinition['status']; port?: number } | undefined {
    return this.states.get(mockId);
  }
}

describe('MockService', () => {
  it('imports and starts a mock server', async () => {
    const repository = new InMemoryRepository();
    const runtime = new InMemoryRuntime(repository);
    const service = new MockService('in-memory', { repository, runtime });
    const mock = await service.importMock({
      sourceType: 'curl',
      content: 'curl -X GET https://example.com/users',
      name: 'test-mock'
    });
    expect(mock.endpoints).toHaveLength(1);

    const started = await service.startMock(mock.id);
    expect(started.status).toBe('running');
    expect(started.port).toBeGreaterThan(0);

    const stopped = await service.stopMock(mock.id);
    expect(stopped?.status).toBe('stopped');
  });
});
