import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { MockDefinition, MockDraft, MockEndpoint, MockProtocol, MockSourceType } from '../types.ts';
import { parseCurlCommand } from '../importers/curl.ts';
import { parseHarDocument } from '../importers/har.ts';
import { parseOpenApiDocument } from '../importers/openapi.ts';
import { parsePostmanCollection } from '../importers/postman.ts';
import { MockRuntimeManager } from '../runtime/mock-runtime.ts';
import { WorkspaceRepository } from '../persistence/sqlite.ts';
import { nowIso, normalizePathPattern, sanitizeIdentifier, toTableName } from '../utils.ts';

export interface ImportMockInput {
  sourceType: MockSourceType;
  content: string;
  name: string;
  protocol?: MockProtocol;
  description?: string;
}

export interface MockServiceRepository {
  saveMock(input: Omit<MockDefinition, 'createdAt' | 'updatedAt' | 'endpoints'> & { createdAt?: string; updatedAt?: string }): MockDefinition;
  saveEndpoints(
    mockId: string,
    mockName: string,
    endpoints: Array<Omit<MockEndpoint, 'id' | 'mockId' | 'orderIndex'> & { tableName?: string }>
  ): MockEndpoint[];
  listMocks(): MockDefinition[];
  getMock(id: string): MockDefinition | undefined;
  deleteMock(id: string): void;
  listEndpointsByMockId(mockId: string): MockEndpoint[];
  upsertEndpoint(mockId: string, mockName: string, endpoint: Partial<MockEndpoint> & Pick<MockEndpoint, 'method' | 'path' | 'name'>): MockEndpoint;
  deleteEndpoint(endpointId: string): void;
  listLogs(mockId?: string): Array<unknown>;
  listRowsByEndpointId(mockId: string, endpointId: string): Array<{ id: string; data: unknown; createdAt: string; updatedAt: string }>;
  replaceRowsForEndpoint(mockId: string, endpointId: string, rows: Record<string, unknown>[]): void;
  appendLog(mockId: string | undefined, level: 'info' | 'warn' | 'error', message: string, payload?: unknown): unknown;
}

export interface MockServiceRuntime {
  start(mockId: string): Promise<MockDefinition>;
  stop(mockId: string): Promise<MockDefinition | undefined>;
  sync(mockId: string): Promise<MockDefinition>;
  listRuntimeStates(): unknown[];
  getRuntime(mockId: string): { status: MockDefinition['status']; port?: number } | undefined;
}

interface MockServiceDependencies {
  repository?: MockServiceRepository;
  runtime?: MockServiceRuntime;
}

export class MockService {
  readonly repository: MockServiceRepository;
  readonly runtime: MockServiceRuntime;

  constructor(
    private readonly rootDir = path.join(os.homedir(), '.mock-serv'),
    dependencies: MockServiceDependencies = {}
  ) {
    if (dependencies.repository) {
      this.repository = dependencies.repository;
      this.runtime = dependencies.runtime ?? new MockRuntimeManager(this.repository as WorkspaceRepository);
      return;
    }

    fs.mkdirSync(rootDir, { recursive: true });
    const repository = new WorkspaceRepository(path.join(rootDir, 'workspace.sqlite'));
    this.repository = repository;
    this.runtime = dependencies.runtime ?? new MockRuntimeManager(repository);
  }

  async importMock(input: ImportMockInput): Promise<MockDefinition> {
    const draft = await this.parseImport(input.sourceType, input.content);
    const mockId = nanoid();
    const createdAt = nowIso();
    const mock: MockDefinition = {
      id: mockId,
      name: input.name.trim(),
      protocol: input.protocol ?? draft.protocol,
      description: input.description ?? draft.description,
      sourceType: input.sourceType,
      sourceRef: draft.sourceRef,
      status: 'stopped',
      port: undefined,
      latencyMs: 0,
      errorRate: 0,
      graphqlEnabled: (input.protocol ?? draft.protocol) === 'graphql',
      createdAt,
      updatedAt: createdAt,
      endpoints: []
    };
    const saved = this.repository.saveMock(mock);
    const endpoints = draft.endpoints.map((endpoint, index) => ({
      ...endpoint,
      id: nanoid(),
      mockId: saved.id,
      tableName: toTableName(saved.name, endpoint.path, endpoint.method),
      orderIndex: index
    }));
    this.repository.saveEndpoints(saved.id, saved.name, endpoints);
    this.repository.appendLog(saved.id, 'info', `Imported ${input.sourceType} definition with ${endpoints.length} endpoint(s)`);
    return this.getMock(saved.id)!;
  }

  async parseImport(sourceType: MockSourceType, content: string): Promise<MockDraft> {
    switch (sourceType) {
      case 'openapi':
        return parseOpenApiDocument(content);
      case 'postman':
        return parsePostmanCollection(content);
      case 'har':
        return parseHarDocument(content);
      case 'curl':
        return parseCurlCommand(content);
      default:
        throw new Error(`Unsupported import type: ${sourceType}`);
    }
  }

  listMocks(): MockDefinition[] {
    return this.repository.listMocks().map((mock) => this.enrichMock(mock));
  }

  getMock(mockId: string): MockDefinition | undefined {
    const mock = this.repository.getMock(mockId);
    return mock ? this.enrichMock(mock) : undefined;
  }

  saveMock(mock: MockDefinition): MockDefinition {
    const saved = this.repository.saveMock({ ...mock, updatedAt: nowIso() });
    if (mock.endpoints?.length) {
      this.repository.saveEndpoints(saved.id, saved.name, mock.endpoints);
    }
    void this.runtime.sync(saved.id);
    return this.getMock(saved.id)!;
  }

  deleteMock(mockId: string): void {
    void this.runtime.stop(mockId);
    this.repository.deleteMock(mockId);
  }

  async startMock(mockId: string): Promise<MockDefinition> {
    const started = await this.runtime.start(mockId);
    return this.getMock(started.id)!;
  }

  async stopMock(mockId: string): Promise<MockDefinition | undefined> {
    const stopped = await this.runtime.stop(mockId);
    return stopped ? this.getMock(stopped.id) : undefined;
  }

  async syncMock(mockId: string): Promise<MockDefinition> {
    const synced = await this.runtime.sync(mockId);
    return this.getMock(synced.id)!;
  }

  updateMock(mockId: string, patch: Partial<MockDefinition>): MockDefinition {
    const existing = this.repository.getMock(mockId);
    if (!existing) throw new Error(`Mock not found: ${mockId}`);
    const saved = this.repository.saveMock({ ...existing, ...patch, updatedAt: nowIso() });
    void this.runtime.sync(mockId);
    return this.getMock(saved.id)!;
  }

  upsertEndpoint(mockId: string, endpoint: Partial<MockEndpoint> & Pick<MockEndpoint, 'method' | 'path' | 'name'>): MockDefinition {
    const mock = this.repository.getMock(mockId);
    if (!mock) throw new Error(`Mock not found: ${mockId}`);
    this.repository.upsertEndpoint(mockId, mock.name, endpoint);
    void this.runtime.sync(mockId);
    return this.getMock(mockId)!;
  }

  deleteEndpoint(mockId: string, endpointId: string): MockDefinition {
    this.repository.deleteEndpoint(endpointId);
    void this.runtime.sync(mockId);
    return this.getMock(mockId)!;
  }

  listLogs(mockId?: string) {
    return this.repository.listLogs(mockId);
  }

  listRuntimeStates() {
    return this.runtime.listRuntimeStates();
  }

  listRows(mockId: string, endpointId: string) {
    return this.repository.listRowsByEndpointId(mockId, endpointId);
  }

  seedRows(mockId: string, endpointId: string, rows: Record<string, unknown>[]) {
    this.repository.replaceRowsForEndpoint(mockId, endpointId, rows);
    return this.getMock(mockId)!;
  }

  private enrichMock(mock: MockDefinition): MockDefinition {
    const runtime = this.runtime.getRuntime(mock.id);
    return {
      ...mock,
      status: runtime?.status ?? mock.status,
      port: runtime?.port ?? mock.port,
      protocol: mock.protocol,
      endpoints: this.repository.listEndpointsByMockId(mock.id)
    };
  }
}

export function defaultMockName(sourceType: MockSourceType): string {
  return `${sourceType}_mock`;
}

export function ensureUniqueMockName(name: string): string {
  return sanitizeIdentifier(name).toLowerCase();
}

export function normalizeMockEndpointPath(pathValue: string): string {
  return normalizePathPattern(pathValue);
}
