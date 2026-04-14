import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { LogEntry, MockDefinition, MockEndpoint, MockRow } from '../types.ts';
import { nowIso, sanitizeIdentifier, safeJsonParse, stableId, toTableName } from '../utils.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as any;

interface MockRowRecord {
  id: string;
  name: string;
  protocol: string;
  description: string | null;
  sourceType: string;
  sourceRef: string | null;
  port: number | null;
  status: string;
  latencyMs: number;
  errorRate: number;
  graphqlEnabled: number;
  createdAt: string;
  updatedAt: string;
}

interface EndpointRowRecord {
  id: string;
  mockId: string;
  name: string;
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  requestHeaders: string;
  pathParameters: string;
  queryParameters: string;
  requestBodySchema: string | null;
  responseSchema: string | null;
  responseExample: string | null;
  statusCode: number;
  latencyMs: number;
  errorRate: number;
  tableName: string;
  orderIndex: number;
}

type StoredRowRecord = {
  id: string;
  data: string;
  createdAt: string;
  updatedAt: string;
};

type LogRowRecord = {
  id: number;
  mockId: string | null;
  level: string;
  message: string;
  payload: string | null;
  createdAt: string;
};

export class WorkspaceRepository {
  private db: any;

  constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.ensureSchema();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mocks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        protocol TEXT NOT NULL,
        description TEXT,
        sourceType TEXT NOT NULL,
        sourceRef TEXT,
        port INTEGER,
        status TEXT NOT NULL,
        latencyMs INTEGER NOT NULL DEFAULT 0,
        errorRate REAL NOT NULL DEFAULT 0,
        graphqlEnabled INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS endpoints (
        id TEXT PRIMARY KEY,
        mockId TEXT NOT NULL,
        name TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        summary TEXT,
        description TEXT,
        requestHeaders TEXT NOT NULL,
        pathParameters TEXT NOT NULL,
        queryParameters TEXT NOT NULL,
        requestBodySchema TEXT,
        responseSchema TEXT,
        responseExample TEXT,
        statusCode INTEGER NOT NULL DEFAULT 200,
        latencyMs INTEGER NOT NULL DEFAULT 0,
        errorRate REAL NOT NULL DEFAULT 0,
        tableName TEXT NOT NULL,
        orderIndex INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (mockId) REFERENCES mocks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS rows (
        id TEXT PRIMARY KEY,
        mockId TEXT NOT NULL,
        endpointId TEXT NOT NULL,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (mockId) REFERENCES mocks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mockId TEXT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        payload TEXT,
        createdAt TEXT NOT NULL
      );
    `);
  }

  private rowToMock(row: MockRowRecord): MockDefinition {
    const endpoints = this.listEndpointsByMockId(row.id);
    return {
      id: row.id,
      name: row.name,
      protocol: row.protocol as MockDefinition['protocol'],
      description: row.description ?? undefined,
      sourceType: row.sourceType as MockDefinition['sourceType'],
      sourceRef: row.sourceRef ?? undefined,
      port: row.port ?? undefined,
      status: row.status as MockDefinition['status'],
      latencyMs: row.latencyMs,
      errorRate: row.errorRate,
      graphqlEnabled: Boolean(row.graphqlEnabled),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      endpoints
    };
  }

  private rowToEndpoint(row: EndpointRowRecord): MockEndpoint {
    return {
      id: row.id,
      mockId: row.mockId,
      name: row.name,
      method: row.method,
      path: row.path,
      summary: row.summary ?? undefined,
      description: row.description ?? undefined,
      requestHeaders: safeJsonParse<Record<string, string>>(row.requestHeaders, {}),
      pathParameters: safeJsonParse(row.pathParameters, []),
      queryParameters: safeJsonParse(row.queryParameters, []),
      requestBodySchema: safeJsonParse(row.requestBodySchema ?? undefined, undefined),
      responseSchema: safeJsonParse(row.responseSchema ?? undefined, undefined),
      responseExample: safeJsonParse(row.responseExample ?? undefined, undefined),
      statusCode: row.statusCode,
      latencyMs: row.latencyMs,
      errorRate: row.errorRate,
      tableName: row.tableName,
      orderIndex: row.orderIndex
    };
  }

  listMocks(): MockDefinition[] {
    const rows = this.db.prepare('SELECT * FROM mocks ORDER BY updatedAt DESC').all() as MockRowRecord[];
    return rows.map((row) => this.rowToMock(row));
  }

  getMock(id: string): MockDefinition | undefined {
    const row = this.db.prepare('SELECT * FROM mocks WHERE id = ?').get(id) as MockRowRecord | undefined;
    return row ? this.rowToMock(row) : undefined;
  }

  getMockByName(name: string): MockDefinition | undefined {
    const row = this.db.prepare('SELECT * FROM mocks WHERE name = ?').get(name) as MockRowRecord | undefined;
    return row ? this.rowToMock(row) : undefined;
  }

  saveMock(input: Omit<MockDefinition, 'createdAt' | 'updatedAt' | 'endpoints'> & { createdAt?: string; updatedAt?: string }): MockDefinition {
    const existing = this.getMock(input.id);
    const timestamps = {
      createdAt: input.createdAt ?? existing?.createdAt ?? nowIso(),
      updatedAt: input.updatedAt ?? nowIso()
    };

    this.db.prepare(`
      INSERT INTO mocks (id, name, protocol, description, sourceType, sourceRef, port, status, latencyMs, errorRate, graphqlEnabled, createdAt, updatedAt)
      VALUES (@id, @name, @protocol, @description, @sourceType, @sourceRef, @port, @status, @latencyMs, @errorRate, @graphqlEnabled, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        protocol = excluded.protocol,
        description = excluded.description,
        sourceType = excluded.sourceType,
        sourceRef = excluded.sourceRef,
        port = excluded.port,
        status = excluded.status,
        latencyMs = excluded.latencyMs,
        errorRate = excluded.errorRate,
        graphqlEnabled = excluded.graphqlEnabled,
        updatedAt = excluded.updatedAt
    `).run({
      ...input,
      description: input.description ?? null,
      sourceRef: input.sourceRef ?? null,
      port: input.port ?? null,
      graphqlEnabled: input.graphqlEnabled ? 1 : 0,
      ...timestamps
    });

    return this.getMock(input.id)!;
  }

  deleteMock(id: string): void {
    this.db.prepare('DELETE FROM endpoints WHERE mockId = ?').run(id);
    this.db.prepare('DELETE FROM rows WHERE mockId = ?').run(id);
    this.db.prepare('DELETE FROM logs WHERE mockId = ?').run(id);
    this.db.prepare('DELETE FROM mocks WHERE id = ?').run(id);
  }

  listEndpointsByMockId(mockId: string): MockEndpoint[] {
    const rows = this.db.prepare('SELECT * FROM endpoints WHERE mockId = ? ORDER BY orderIndex ASC').all(mockId) as EndpointRowRecord[];
    return rows.map((row) => this.rowToEndpoint(row));
  }

  getEndpoint(endpointId: string): MockEndpoint | undefined {
    const row = this.db.prepare('SELECT * FROM endpoints WHERE id = ?').get(endpointId) as EndpointRowRecord | undefined;
    return row ? this.rowToEndpoint(row) : undefined;
  }

  saveEndpoints(
    mockId: string,
    mockName: string,
    endpoints: Array<Omit<MockEndpoint, 'id' | 'mockId' | 'orderIndex'> & { tableName?: string }>
  ): MockEndpoint[] {
    const insert = this.db.prepare(`
      INSERT INTO endpoints (id, mockId, name, method, path, summary, description, requestHeaders, pathParameters, queryParameters, requestBodySchema, responseSchema, responseExample, statusCode, latencyMs, errorRate, tableName, orderIndex)
      VALUES (@id, @mockId, @name, @method, @path, @summary, @description, @requestHeaders, @pathParameters, @queryParameters, @requestBodySchema, @responseSchema, @responseExample, @statusCode, @latencyMs, @errorRate, @tableName, @orderIndex)
    `);

    this.transaction(() => {
      this.db.prepare('DELETE FROM endpoints WHERE mockId = ?').run(mockId);
      endpoints.forEach((endpoint, index) => {
        const tableName = endpoint.tableName || toTableName(mockName, endpoint.path, endpoint.method);
        this.ensureCrudTable(tableName);
        insert.run({
          id: stableId('endpoint'),
          mockId,
          name: endpoint.name,
          method: endpoint.method.toUpperCase(),
          path: endpoint.path,
          summary: endpoint.summary ?? null,
          description: endpoint.description ?? null,
          requestHeaders: JSON.stringify(endpoint.requestHeaders ?? {}),
          pathParameters: JSON.stringify(endpoint.pathParameters ?? []),
          queryParameters: JSON.stringify(endpoint.queryParameters ?? []),
          requestBodySchema: endpoint.requestBodySchema ? JSON.stringify(endpoint.requestBodySchema) : null,
          responseSchema: endpoint.responseSchema ? JSON.stringify(endpoint.responseSchema) : null,
          responseExample: endpoint.responseExample !== undefined ? JSON.stringify(endpoint.responseExample) : null,
          statusCode: endpoint.statusCode,
          latencyMs: endpoint.latencyMs,
          errorRate: endpoint.errorRate,
          tableName,
          orderIndex: index
        });
      });
    });

    return this.listEndpointsByMockId(mockId);
  }

  upsertEndpoint(mockId: string, mockName: string, endpoint: Partial<MockEndpoint> & Pick<MockEndpoint, 'method' | 'path' | 'name'>): MockEndpoint {
    const current = endpoint.id ? this.getEndpoint(endpoint.id) : undefined;
    const tableName = endpoint.tableName || current?.tableName || toTableName(mockName, endpoint.path, endpoint.method);
    this.ensureCrudTable(tableName);
    const row = {
      id: endpoint.id ?? stableId('endpoint'),
      mockId,
      name: endpoint.name,
      method: endpoint.method.toUpperCase(),
      path: endpoint.path,
      summary: endpoint.summary ?? current?.summary ?? null,
      description: endpoint.description ?? current?.description ?? null,
      requestHeaders: JSON.stringify(endpoint.requestHeaders ?? current?.requestHeaders ?? {}),
      pathParameters: JSON.stringify(endpoint.pathParameters ?? current?.pathParameters ?? []),
      queryParameters: JSON.stringify(endpoint.queryParameters ?? current?.queryParameters ?? []),
      requestBodySchema: endpoint.requestBodySchema
        ? JSON.stringify(endpoint.requestBodySchema)
        : current?.requestBodySchema
          ? JSON.stringify(current.requestBodySchema)
          : null,
      responseSchema: endpoint.responseSchema
        ? JSON.stringify(endpoint.responseSchema)
        : current?.responseSchema
          ? JSON.stringify(current.responseSchema)
          : null,
      responseExample:
        endpoint.responseExample !== undefined
          ? JSON.stringify(endpoint.responseExample)
          : current?.responseExample !== undefined
            ? JSON.stringify(current.responseExample)
            : null,
      statusCode: endpoint.statusCode ?? current?.statusCode ?? 200,
      latencyMs: endpoint.latencyMs ?? current?.latencyMs ?? 0,
      errorRate: endpoint.errorRate ?? current?.errorRate ?? 0,
      tableName,
      orderIndex: current?.orderIndex ?? 0
    };

    this.db.prepare(`
      INSERT INTO endpoints (id, mockId, name, method, path, summary, description, requestHeaders, pathParameters, queryParameters, requestBodySchema, responseSchema, responseExample, statusCode, latencyMs, errorRate, tableName, orderIndex)
      VALUES (@id, @mockId, @name, @method, @path, @summary, @description, @requestHeaders, @pathParameters, @queryParameters, @requestBodySchema, @responseSchema, @responseExample, @statusCode, @latencyMs, @errorRate, @tableName, @orderIndex)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        method = excluded.method,
        path = excluded.path,
        summary = excluded.summary,
        description = excluded.description,
        requestHeaders = excluded.requestHeaders,
        pathParameters = excluded.pathParameters,
        queryParameters = excluded.queryParameters,
        requestBodySchema = excluded.requestBodySchema,
        responseSchema = excluded.responseSchema,
        responseExample = excluded.responseExample,
        statusCode = excluded.statusCode,
        latencyMs = excluded.latencyMs,
        errorRate = excluded.errorRate,
        tableName = excluded.tableName,
        orderIndex = excluded.orderIndex
    `).run(row);

    return this.getEndpoint(row.id)!;
  }

  deleteEndpoint(endpointId: string): void {
    this.db.prepare('DELETE FROM rows WHERE endpointId = ?').run(endpointId);
    this.db.prepare('DELETE FROM endpoints WHERE id = ?').run(endpointId);
  }

  listRowsByEndpointId(mockId: string, endpointId: string): MockRow[] {
    const rows = this.db.prepare('SELECT * FROM rows WHERE mockId = ? AND endpointId = ? ORDER BY createdAt ASC').all(mockId, endpointId) as StoredRowRecord[];
    return rows.map((row) => ({
      id: row.id,
      data: safeJsonParse(row.data, {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }

  getRowsByEndpoint(endpointId: string): MockRow[] {
    const rows = this.db.prepare('SELECT * FROM rows WHERE endpointId = ? ORDER BY createdAt ASC').all(endpointId) as StoredRowRecord[];
    return rows.map((row) => ({
      id: row.id,
      data: safeJsonParse(row.data, {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }

  insertRow(mockId: string, endpointId: string, data: Record<string, unknown>, explicitId?: string): MockRow {
    const now = nowIso();
    const row = {
      id: explicitId || stableId('row'),
      mockId,
      endpointId,
      data: JSON.stringify({ id: explicitId, ...data }),
      createdAt: now,
      updatedAt: now
    };
    this.db.prepare('INSERT INTO rows (id, mockId, endpointId, data, createdAt, updatedAt) VALUES (@id, @mockId, @endpointId, @data, @createdAt, @updatedAt)').run(row);
    return { id: row.id, data: safeJsonParse(row.data, {}), createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  updateRow(mockId: string, endpointId: string, id: string, data: Record<string, unknown>): MockRow {
    const existing = this.db.prepare('SELECT * FROM rows WHERE mockId = ? AND endpointId = ? AND id = ?').get(mockId, endpointId, id) as StoredRowRecord | undefined;
    const now = nowIso();
    const merged = existing ? { ...safeJsonParse<Record<string, unknown>>(existing.data, {}), ...data } : data;

    this.db.prepare(`
      INSERT INTO rows (id, mockId, endpointId, data, createdAt, updatedAt)
      VALUES (@id, @mockId, @endpointId, @data, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt
    `).run({
      id,
      mockId,
      endpointId,
      data: JSON.stringify(merged),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });

    return { id, data: merged, createdAt: existing?.createdAt ?? now, updatedAt: now };
  }

  deleteRow(mockId: string, endpointId: string, id: string): MockRow | undefined {
    const existing = this.db.prepare('SELECT * FROM rows WHERE mockId = ? AND endpointId = ? AND id = ?').get(mockId, endpointId, id) as StoredRowRecord | undefined;
    if (!existing) return undefined;
    this.db.prepare('DELETE FROM rows WHERE id = ?').run(id);
    return { id: existing.id, data: safeJsonParse(existing.data, {}), createdAt: existing.createdAt, updatedAt: existing.updatedAt };
  }

  replaceRowsForEndpoint(mockId: string, endpointId: string, rows: Record<string, unknown>[]): void {
    const insert = this.db.prepare('INSERT INTO rows (id, mockId, endpointId, data, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)');
    const now = nowIso();

    this.transaction(() => {
      this.db.prepare('DELETE FROM rows WHERE mockId = ? AND endpointId = ?').run(mockId, endpointId);
      rows.forEach((item) => {
        const rowId = String((item as Record<string, unknown>).id ?? stableId('row'));
        insert.run(rowId, mockId, endpointId, JSON.stringify(item), now, now);
      });
    });
  }

  appendLog(mockId: string | undefined, level: LogEntry['level'], message: string, payload?: unknown): LogEntry {
    const createdAt = nowIso();
    const result = this.db.prepare('INSERT INTO logs (mockId, level, message, payload, createdAt) VALUES (?, ?, ?, ?, ?)').run(
      mockId ?? null,
      level,
      message,
      payload !== undefined ? JSON.stringify(payload) : null,
      createdAt
    );

    return {
      id: Number(result.lastInsertRowid),
      mockId,
      level,
      message,
      payload,
      createdAt
    };
  }

  listLogs(mockId?: string): LogEntry[] {
    const rows = mockId
      ? (this.db.prepare('SELECT * FROM logs WHERE mockId = ? ORDER BY id DESC LIMIT 200').all(mockId) as LogRowRecord[])
      : (this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 200').all() as LogRowRecord[]);

    return rows.map((row) => ({
      id: row.id,
      mockId: row.mockId ?? undefined,
      level: row.level as LogEntry['level'],
      message: row.message,
      payload: safeJsonParse(row.payload ?? undefined, undefined),
      createdAt: row.createdAt
    }));
  }

  ensureCrudTable(tableName: string): void {
    const safeTable = sanitizeIdentifier(tableName).toLowerCase();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "${safeTable}" (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
  }

  listCrudRows(tableName: string): MockRow[] {
    const safeTable = sanitizeIdentifier(tableName).toLowerCase();
    const rows = this.db.prepare(`SELECT * FROM "${safeTable}" ORDER BY createdAt ASC`).all() as StoredRowRecord[];
    return rows.map((row) => ({
      id: row.id,
      data: safeJsonParse(row.data, {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }

  seedCrudRow(tableName: string, data: Record<string, unknown>): MockRow {
    const safeTable = sanitizeIdentifier(tableName).toLowerCase();
    const now = nowIso();
    const row = { id: String(data.id ?? stableId('row')), data: JSON.stringify(data), createdAt: now, updatedAt: now };
    this.db.prepare(`INSERT OR REPLACE INTO "${safeTable}" (id, data, createdAt, updatedAt) VALUES (?, ?, ?, ?)`).run(
      row.id,
      row.data,
      row.createdAt,
      row.updatedAt
    );
    return { id: row.id, data, createdAt: now, updatedAt: now };
  }

  deleteCrudRow(tableName: string, id: string): void {
    const safeTable = sanitizeIdentifier(tableName).toLowerCase();
    this.db.prepare(`DELETE FROM "${safeTable}" WHERE id = ?`).run(id);
  }
}
