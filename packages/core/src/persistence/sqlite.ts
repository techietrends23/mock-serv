import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { CapturedCall, CaptureSession, LogEntry, MockDefinition, MockEndpoint, MockRow } from '../types.ts';
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
  proxyEnabled?: number;
  proxyUrl?: string | null;
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
  matchRules?: string | null;
  responseTemplate?: string | null;
  responseSequence?: string | null;
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
        matchRules TEXT,
        statusCode INTEGER NOT NULL DEFAULT 200,
        latencyMs INTEGER NOT NULL DEFAULT 0,
        errorRate REAL NOT NULL DEFAULT 0,
        responseTemplate TEXT,
        responseSequence TEXT,
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
      CREATE TABLE IF NOT EXISTS capture_sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        proxyPort INTEGER,
        status TEXT NOT NULL DEFAULT 'idle',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS captured_calls (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        host TEXT,
        path TEXT,
        queryString TEXT,
        requestHeaders TEXT,
        requestBody TEXT,
        responseStatus INTEGER,
        responseHeaders TEXT,
        responseBody TEXT,
        contentType TEXT,
        durationMs REAL,
        timestamp TEXT,
        FOREIGN KEY (sessionId) REFERENCES capture_sessions(id) ON DELETE CASCADE
      );
    `);
    this.ensureColumn('mocks', 'proxyEnabled', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('mocks', 'proxyUrl', 'TEXT');
    this.ensureColumn('endpoints', 'matchRules', 'TEXT');
    this.ensureColumn('endpoints', 'responseTemplate', 'TEXT');
    this.ensureColumn('endpoints', 'responseSequence', 'TEXT');
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
      proxyEnabled: Boolean(row.proxyEnabled),
      proxyUrl: row.proxyUrl ?? undefined,
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
      matchRules: safeJsonParse(row.matchRules ?? undefined, undefined),
      responseTemplate: row.responseTemplate ?? undefined,
      responseSequence: safeJsonParse(row.responseSequence ?? undefined, undefined) as MockEndpoint['responseSequence'],
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
      INSERT INTO mocks (id, name, protocol, description, sourceType, sourceRef, port, status, latencyMs, errorRate, graphqlEnabled, proxyEnabled, proxyUrl, createdAt, updatedAt)
      VALUES (@id, @name, @protocol, @description, @sourceType, @sourceRef, @port, @status, @latencyMs, @errorRate, @graphqlEnabled, @proxyEnabled, @proxyUrl, @createdAt, @updatedAt)
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
        proxyEnabled = excluded.proxyEnabled,
        proxyUrl = excluded.proxyUrl,
        updatedAt = excluded.updatedAt
    `).run({
      ...input,
      description: input.description ?? null,
      sourceRef: input.sourceRef ?? null,
      port: input.port ?? null,
      graphqlEnabled: input.graphqlEnabled ? 1 : 0,
      proxyEnabled: input.proxyEnabled ? 1 : 0,
      proxyUrl: input.proxyUrl ?? null,
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
      INSERT INTO endpoints (id, mockId, name, method, path, summary, description, requestHeaders, pathParameters, queryParameters, requestBodySchema, responseSchema, responseExample, matchRules, statusCode, latencyMs, errorRate, responseTemplate, responseSequence, tableName, orderIndex)
      VALUES (@id, @mockId, @name, @method, @path, @summary, @description, @requestHeaders, @pathParameters, @queryParameters, @requestBodySchema, @responseSchema, @responseExample, @matchRules, @statusCode, @latencyMs, @errorRate, @responseTemplate, @responseSequence, @tableName, @orderIndex)
    `);

    this.transaction(() => {
      this.db.prepare('DELETE FROM endpoints WHERE mockId = ?').run(mockId);
      endpoints.forEach((endpoint, index) => {
        const tableName = endpoint.tableName || toTableName(mockName, endpoint.path, endpoint.method);
        this.ensureCrudTable(tableName);
        const ep = endpoint as MockEndpoint;
        insert.run({
          id: ep.id || stableId('endpoint'),
          mockId,
          name: ep.name,
          method: ep.method.toUpperCase(),
          path: ep.path,
          summary: ep.summary ?? null,
          description: ep.description ?? null,
          requestHeaders: JSON.stringify(ep.requestHeaders ?? {}),
          pathParameters: JSON.stringify(ep.pathParameters ?? []),
          queryParameters: JSON.stringify(ep.queryParameters ?? []),
          requestBodySchema: ep.requestBodySchema ? JSON.stringify(ep.requestBodySchema) : null,
          responseSchema: ep.responseSchema ? JSON.stringify(ep.responseSchema) : null,
          responseExample: ep.responseExample !== undefined ? JSON.stringify(ep.responseExample) : null,
          matchRules: ep.matchRules?.length ? JSON.stringify(ep.matchRules) : null,
          statusCode: ep.statusCode,
          latencyMs: ep.latencyMs,
          errorRate: ep.errorRate,
          responseTemplate: ep.responseTemplate ?? null,
          responseSequence: ep.responseSequence?.length ? JSON.stringify(ep.responseSequence) : null,
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
    const row: Record<string, unknown> = {
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
      matchRules:
        endpoint.matchRules !== undefined
          ? endpoint.matchRules.length
            ? JSON.stringify(endpoint.matchRules)
            : null
          : current?.matchRules?.length
            ? JSON.stringify(current.matchRules)
            : null,
      responseTemplate: endpoint.responseTemplate !== undefined
        ? endpoint.responseTemplate
        : current?.responseTemplate ?? null,
      responseSequence: endpoint.responseSequence !== undefined
        ? endpoint.responseSequence?.length
          ? JSON.stringify(endpoint.responseSequence)
          : null
        : current?.responseSequence?.length
          ? JSON.stringify(current.responseSequence)
          : null,
      statusCode: endpoint.statusCode ?? current?.statusCode ?? 200,
      latencyMs: endpoint.latencyMs ?? current?.latencyMs ?? 0,
      errorRate: endpoint.errorRate ?? current?.errorRate ?? 0,
      tableName,
      orderIndex: current?.orderIndex ?? 0
    };

    this.db.prepare(`
      INSERT INTO endpoints (id, mockId, name, method, path, summary, description, requestHeaders, pathParameters, queryParameters, requestBodySchema, responseSchema, responseExample, matchRules, statusCode, latencyMs, errorRate, responseTemplate, responseSequence, tableName, orderIndex)
      VALUES (@id, @mockId, @name, @method, @path, @summary, @description, @requestHeaders, @pathParameters, @queryParameters, @requestBodySchema, @responseSchema, @responseExample, @matchRules, @statusCode, @latencyMs, @errorRate, @responseTemplate, @responseSequence, @tableName, @orderIndex)
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
        matchRules = excluded.matchRules,
        statusCode = excluded.statusCode,
        latencyMs = excluded.latencyMs,
        errorRate = excluded.errorRate,
        responseTemplate = excluded.responseTemplate,
        responseSequence = excluded.responseSequence,
        tableName = excluded.tableName,
        orderIndex = excluded.orderIndex
    `).run(row);

    return this.getEndpoint(row.id as string)!;
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

  listCaptureSessions(): CaptureSession[] {
    const rows = this.db.prepare('SELECT * FROM capture_sessions ORDER BY createdAt DESC').all() as Array<{
      id: string;
      name: string;
      proxyPort: number | null;
      status: string;
      createdAt: string;
      updatedAt: string;
    }>;
    return rows.map((row) => ({
      ...row,
      proxyPort: row.proxyPort ?? undefined,
      status: row.status as CaptureSession['status'],
      callCount: this.db.prepare('SELECT COUNT(*) as count FROM captured_calls WHERE sessionId = ?').get(row.id).count
    }));
  }

  getCaptureSession(id: string): CaptureSession | undefined {
    const row = this.db.prepare('SELECT * FROM capture_sessions WHERE id = ?').get(id) as {
      id: string;
      name: string;
      proxyPort: number | null;
      status: string;
      createdAt: string;
      updatedAt: string;
    } | undefined;
    if (!row) return undefined;
    return {
      ...row,
      proxyPort: row.proxyPort ?? undefined,
      status: row.status as CaptureSession['status'],
      callCount: this.db.prepare('SELECT COUNT(*) as count FROM captured_calls WHERE sessionId = ?').get(row.id).count
    };
  }

  saveCaptureSession(session: Omit<CaptureSession, 'callCount'>): CaptureSession {
    this.db.prepare(`
      INSERT INTO capture_sessions (id, name, proxyPort, status, createdAt, updatedAt)
      VALUES (@id, @name, @proxyPort, @status, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        proxyPort = excluded.proxyPort,
        status = excluded.status,
        updatedAt = excluded.updatedAt
    `).run({
      ...session,
      proxyPort: session.proxyPort ?? null
    });
    return this.getCaptureSession(session.id)!;
  }

  deleteCaptureSession(id: string): void {
    this.db.prepare('DELETE FROM captured_calls WHERE sessionId = ?').run(id);
    this.db.prepare('DELETE FROM capture_sessions WHERE id = ?').run(id);
  }

  listCapturedCalls(sessionId: string): CapturedCall[] {
    const rows = this.db.prepare('SELECT * FROM captured_calls WHERE sessionId = ? ORDER BY timestamp DESC').all(sessionId) as Array<{
      id: string;
      sessionId: string;
      method: string;
      url: string;
      host: string | null;
      path: string | null;
      queryString: string | null;
      requestHeaders: string | null;
      requestBody: string | null;
      responseStatus: number | null;
      responseHeaders: string | null;
      responseBody: string | null;
      contentType: string | null;
      durationMs: number | null;
      timestamp: string | null;
    }>;
    return rows.map(this.rowToCapturedCall);
  }

  getCapturedCall(id: string): CapturedCall | undefined {
    const row = this.db.prepare('SELECT * FROM captured_calls WHERE id = ?').get(id) as any;
    return row ? this.rowToCapturedCall(row) : undefined;
  }

  deleteCapturedCall(id: string): void {
    this.db.prepare('DELETE FROM captured_calls WHERE id = ?').run(id);
  }

  private rowToCapturedCall(row: any): CapturedCall {
    return {
      id: row.id,
      sessionId: row.sessionId,
      method: row.method,
      url: row.url,
      host: row.host ?? '',
      path: row.path ?? '',
      queryString: row.queryString ?? '',
      requestHeaders: safeJsonParse(row.requestHeaders ?? undefined, {}),
      requestBody: safeJsonParse(row.requestBody ?? undefined, undefined),
      responseStatus: row.responseStatus ?? 0,
      responseHeaders: safeJsonParse(row.responseHeaders ?? undefined, {}),
      responseBody: safeJsonParse(row.responseBody ?? undefined, undefined),
      contentType: row.contentType ?? '',
      durationMs: row.durationMs ?? 0,
      timestamp: row.timestamp ?? ''
    };
  }

  insertCapturedCall(call: Omit<CapturedCall, 'id'> & { id: string }): CapturedCall {
    this.db.prepare(`
      INSERT INTO captured_calls (id, sessionId, method, url, host, path, queryString, requestHeaders, requestBody, responseStatus, responseHeaders, responseBody, contentType, durationMs, timestamp)
      VALUES (@id, @sessionId, @method, @url, @host, @path, @queryString, @requestHeaders, @requestBody, @responseStatus, @responseHeaders, @responseBody, @contentType, @durationMs, @timestamp)
    `).run({
      id: call.id,
      sessionId: call.sessionId,
      method: call.method,
      url: call.url,
      host: call.host,
      path: call.path,
      queryString: call.queryString,
      requestHeaders: JSON.stringify(call.requestHeaders),
      requestBody: call.requestBody !== undefined ? JSON.stringify(call.requestBody) : null,
      responseStatus: call.responseStatus,
      responseHeaders: JSON.stringify(call.responseHeaders),
      responseBody: call.responseBody !== undefined ? JSON.stringify(call.responseBody) : null,
      contentType: call.contentType,
      durationMs: call.durationMs,
      timestamp: call.timestamp
    });
    return this.getCapturedCall(call.id)!;
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
