import type { MockDefinition, MockStatus } from '../types.ts';
import { GraphQLRuntime } from './graphql.ts';
import { RestRuntime } from './rest.ts';

export class MockRuntimeManager {
  private runtimes = new Map<
    string,
    {
      status: MockStatus;
      port?: number;
      protocol: MockDefinition['protocol'];
      runtime: RestRuntime | GraphQLRuntime;
    }
  >();

  constructor(private readonly repository: {
    getMock(id: string): MockDefinition | undefined;
    saveMock(input: Omit<MockDefinition, 'createdAt' | 'updatedAt' | 'endpoints'> & { createdAt?: string; updatedAt?: string }): MockDefinition;
    appendLog(mockId: string | undefined, level: 'info' | 'warn' | 'error', message: string, payload?: unknown): unknown;
    listCrudRows(tableName: string): Array<{ id: string; data: unknown }>;
    seedCrudRow(tableName: string, data: Record<string, unknown>): { id: string; data: unknown };
    deleteCrudRow(tableName: string, id: string): void;
  }) {}

  listRuntimeStates(): Array<{ mockId: string; status: MockStatus; port?: number; protocol: MockDefinition['protocol'] }> {
    return Array.from(this.runtimes.entries()).map(([mockId, runtime]) => ({
      mockId,
      status: runtime.status,
      port: runtime.port,
      protocol: runtime.protocol
    }));
  }

  getRuntime(mockId: string): { status: MockStatus; port?: number; protocol: MockDefinition['protocol'] } | undefined {
    const runtime = this.runtimes.get(mockId);
    return runtime ? { status: runtime.status, port: runtime.port, protocol: runtime.protocol } : undefined;
  }

  async start(mockId: string): Promise<MockDefinition> {
    const mock = this.repository.getMock(mockId);
    if (!mock) throw new Error(`Mock not found: ${mockId}`);
    await this.stop(mockId);
    const runtime =
      mock.protocol === 'graphql'
        ? new GraphQLRuntime(this.repository)
        : new RestRuntime(this.repository);
    this.runtimes.set(mockId, {
      status: 'starting',
      runtime,
      protocol: mock.protocol
    });
    this.repository.saveMock({ ...mock, status: 'starting' });
    const port = await runtime.start(mock);
    this.runtimes.set(mockId, {
      status: 'running',
      port,
      runtime,
      protocol: mock.protocol
    });
    this.repository.appendLog(mockId, 'info', `Started ${mock.protocol.toUpperCase()} mock on port ${port}`);
    return this.repository.saveMock({ ...mock, port, status: 'running' });
  }

  async stop(mockId: string): Promise<MockDefinition | undefined> {
    const current = this.runtimes.get(mockId);
    if (!current) return this.repository.getMock(mockId);
    current.status = 'stopping';
    await current.runtime.stop();
    this.runtimes.delete(mockId);
    const mock = this.repository.getMock(mockId);
    if (!mock) return undefined;
    this.repository.appendLog(mockId, 'info', 'Stopped mock server');
    return this.repository.saveMock({ ...mock, port: undefined, status: 'stopped' });
  }

  async restart(mockId: string): Promise<MockDefinition> {
    await this.stop(mockId);
    return this.start(mockId);
  }

  async sync(mockId: string): Promise<MockDefinition> {
    const runtime = this.runtimes.get(mockId);
    if (!runtime) {
      const mock = this.repository.getMock(mockId);
      if (!mock) throw new Error(`Mock not found: ${mockId}`);
      return mock;
    }
    return this.restart(mockId);
  }
}
