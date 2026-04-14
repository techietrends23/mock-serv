import React, { useEffect, useMemo, useState } from 'react';
import {
  deleteEndpoint,
  deleteMock,
  importMock,
  listLogs,
  listMocks,
  listRows,
  parseImport,
  saveMock,
  seedRows,
  startMock,
  stopMock,
  syncMock
} from './api';
import type { LogEntry, MockDefinition, MockEndpoint, MockProtocol, MockSourceType } from '@mock-serv/core';

type ImportFormState = {
  sourceType: MockSourceType;
  protocol: MockProtocol;
  name: string;
  description: string;
  content: string;
  fileName: string;
};

type EditorState = MockDefinition | null;

const emptyImport: ImportFormState = {
  sourceType: 'openapi',
  protocol: 'rest',
  name: '',
  description: '',
  content: '',
  fileName: ''
};

function jsonPretty(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseJsonInput(value: string): unknown {
  if (!value.trim()) return undefined;
  return JSON.parse(value);
}

export default function App(): React.ReactElement {
  const [imports, setImportForm] = useState<ImportFormState>(emptyImport);
  const [mocks, setMocks] = useState<MockDefinition[]>([]);
  const [selectedMockId, setSelectedMockId] = useState<string | null>(null);
  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);
  const [selectedMock, setSelectedMock] = useState<EditorState>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [message, setMessage] = useState<string>('');
  const [busy, setBusy] = useState(false);

  async function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    const suggestedName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
    setImportForm((current) => ({
      ...current,
      content,
      fileName: file.name,
      name: current.name || suggestedName
    }));
    setMessage(`Loaded ${file.name}`);
    event.target.value = '';
  }

  async function refreshAll(nextSelectedId = selectedMockId): Promise<void> {
    const nextMocks = await listMocks();
    setMocks(nextMocks);
    const current = nextSelectedId ? nextMocks.find((mock) => mock.id === nextSelectedId) ?? null : null;
    setSelectedMock(current);
    setSelectedEndpointId((prev) => {
      if (!current) return null;
      const endpoint = current.endpoints.find((item) => item.id === prev) ?? current.endpoints[0];
      return endpoint?.id ?? null;
    });
    setLogs(await listLogs(nextSelectedId ?? undefined));
  }

  useEffect(() => {
    void refreshAll();
  }, []);

  const selectedEndpoint = useMemo(() => {
    if (!selectedMock || !selectedEndpointId) return null;
    return selectedMock.endpoints.find((endpoint) => endpoint.id === selectedEndpointId) ?? null;
  }, [selectedMock, selectedEndpointId]);

  async function handleImport(): Promise<void> {
    if (!imports.name.trim() || !imports.content.trim()) {
      setMessage('Provide a mock name and import content.');
      return;
    }
    setBusy(true);
    try {
      await parseImport({ sourceType: imports.sourceType, content: imports.content });
      const imported = await importMock({
        sourceType: imports.sourceType,
        protocol: imports.protocol,
        name: imports.name,
        description: imports.description || undefined,
        content: imports.content
      });
      setMessage(`Imported ${imported.name}`);
      setImportForm(emptyImport);
      setSelectedMockId(imported.id);
      await refreshAll(imported.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleStart(id: string): Promise<void> {
    setBusy(true);
    try {
      await startMock(id);
      await refreshAll(id);
    } finally {
      setBusy(false);
    }
  }

  async function handleStop(id: string): Promise<void> {
    setBusy(true);
    try {
      await stopMock(id);
      await refreshAll(id);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    setBusy(true);
    try {
      await deleteMock(id);
      const remaining = mocks.filter((mock) => mock.id !== id);
      setMocks(remaining);
      setSelectedMockId(remaining[0]?.id ?? null);
      await refreshAll(remaining[0]?.id);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSelected(): Promise<void> {
    if (!selectedMock) return;
    setBusy(true);
    try {
      await saveMock(selectedMock);
      await refreshAll(selectedMock.id);
      setMessage(`Saved ${selectedMock.name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncSelected(): Promise<void> {
    if (!selectedMock) return;
    setBusy(true);
    try {
      await syncMock(selectedMock.id);
      await refreshAll(selectedMock.id);
    } finally {
      setBusy(false);
    }
  }

  async function handleRowSeed(endpoint: MockEndpoint): Promise<void> {
    if (!selectedMock) return;
    const rows = await listRows(selectedMock.id, endpoint.id);
    const seed = rows.length ? rows.map((row) => row.data as Record<string, unknown>) : [{ id: 'sample', name: 'Seed Row', active: true }];
    await seedRows(selectedMock.id, endpoint.id, seed);
    await refreshAll(selectedMock.id);
  }

  function updateSelectedMock(patch: Partial<MockDefinition>): void {
    setSelectedMock((current) => (current ? { ...current, ...patch } : current));
  }

  function updateEndpoint(endpointId: string, patch: Partial<MockEndpoint>): void {
    setSelectedMock((current) =>
      current
        ? {
            ...current,
            endpoints: current.endpoints.map((endpoint) => (endpoint.id === endpointId ? { ...endpoint, ...patch } : endpoint))
          }
        : current
    );
  }

  function addEndpoint(): void {
    if (!selectedMock) return;
    const endpoint: MockEndpoint = {
      id: `draft_${Date.now()}`,
      mockId: selectedMock.id,
      name: 'new_endpoint',
      method: 'GET',
      path: '/new',
      requestHeaders: {},
      pathParameters: [],
      queryParameters: [],
      statusCode: 200,
      latencyMs: 0,
      errorRate: 0,
      tableName: '',
      orderIndex: selectedMock.endpoints.length
    };
    setSelectedMock({ ...selectedMock, endpoints: [...selectedMock.endpoints, endpoint] });
    setSelectedEndpointId(endpoint.id);
  }

  function removeEndpoint(endpointId: string): void {
    if (!selectedMock) return;
    setSelectedMock({
      ...selectedMock,
      endpoints: selectedMock.endpoints.filter((endpoint) => endpoint.id !== endpointId)
    });
    if (selectedEndpointId === endpointId) {
      setSelectedEndpointId(selectedMock.endpoints[0]?.id ?? null);
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">MS</div>
          <div>
            <div className="brand-title">Mock Serv</div>
            <div className="brand-subtitle">Local mock server builder</div>
          </div>
        </div>

        <section className="panel">
          <h2>Import</h2>
          <label>
            Source
            <select
              value={imports.sourceType}
              onChange={(event) =>
                setImportForm((current) => ({
                  ...current,
                  sourceType: event.target.value as MockSourceType
                }))
              }
            >
              <option value="openapi">OpenAPI / Swagger</option>
              <option value="curl">cURL</option>
              <option value="postman">Postman Collection</option>
              <option value="har">HAR</option>
            </select>
          </label>
          <label>
            Protocol
            <select
              value={imports.protocol}
              onChange={(event) =>
                setImportForm((current) => ({
                  ...current,
                  protocol: event.target.value as MockProtocol
                }))
              }
            >
              <option value="rest">REST</option>
              <option value="graphql">GraphQL</option>
            </select>
          </label>
          <label>
            Mock name
            <input value={imports.name} onChange={(event) => setImportForm((current) => ({ ...current, name: event.target.value }))} placeholder="orders_api_mock" />
          </label>
          <label>
            Description
            <input
              value={imports.description}
              onChange={(event) => setImportForm((current) => ({ ...current, description: event.target.value }))}
              placeholder="Optional notes"
            />
          </label>
          <div className="upload-row stretch">
            <label className="file-picker">
              <span className="secondary">Choose local file</span>
              <input
                type="file"
                className="visually-hidden"
                accept=".yaml,.yml,.json,.har,.txt"
                onChange={(event) => void handleFileSelected(event)}
              />
            </label>
            <div className="file-name">{imports.fileName || 'No file selected'}</div>
          </div>
          <label className="stretch">
            Definition
            <textarea
              value={imports.content}
              onChange={(event) => setImportForm((current) => ({ ...current, content: event.target.value }))}
              placeholder="Paste a definition here or load it from a local file"
            />
          </label>
          <button className="primary" disabled={busy} onClick={() => void handleImport()}>
            Analyze and Import
          </button>
          <div className="hint">Name is required before the parsed mock is persisted.</div>
        </section>
      </aside>

      <main className="content">
        <header className="hero">
          <div>
            <p className="eyebrow">Browser UI with local runtime backend</p>
            <h1>Import, edit, start, and inspect local mocks</h1>
          </div>
          <div className="hero-actions">
            <button className="secondary" onClick={() => void refreshAll()}>
              Refresh
            </button>
            <button className="secondary" onClick={() => void handleSyncSelected()} disabled={!selectedMock}>
              Hot reload
            </button>
          </div>
        </header>

        <section className="panel mocks-panel">
          <div className="panel-head">
            <div>
              <h2>Available Mocks</h2>
              <div className="hint">Select a mock to inspect, edit, or control its local server.</div>
            </div>
          </div>
          {mocks.length ? (
            <div className="mock-grid">
              {mocks.map((mock) => {
                const runtime = mock.status === 'running' && mock.port ? `Port ${mock.port}` : mock.status;
                return (
                  <button
                    key={mock.id}
                    className={`mock-card ${selectedMockId === mock.id ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedMockId(mock.id);
                      setSelectedMock(mock);
                    }}
                  >
                    <div className="mock-head">
                      <strong>{mock.name}</strong>
                      <span className={`status ${mock.status}`}>{runtime}</span>
                    </div>
                    <div className="mock-meta">
                      <span>{mock.protocol.toUpperCase()}</span>
                      <span>{mock.endpoints.length} endpoints</span>
                    </div>
                    <div className="actions">
                      {mock.status === 'running' ? (
                        <span className="action-link" onClick={(event) => { event.stopPropagation(); void handleStop(mock.id); }}>
                          Stop
                        </span>
                      ) : (
                        <span className="action-link" onClick={(event) => { event.stopPropagation(); void handleStart(mock.id); }}>
                          Start
                        </span>
                      )}
                      <span className="action-link danger" onClick={(event) => { event.stopPropagation(); void handleDelete(mock.id); }}>
                        Delete
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="mock-empty">No mocks yet. Import a definition to create the first one.</div>
          )}
        </section>

        {selectedMock ? (
          <section className="grid">
            <article className="panel editor">
              <div className="panel-head">
                <h2>Mock Editor</h2>
                <div className="panel-actions">
                  <button className="secondary" onClick={addEndpoint}>
                    Add endpoint
                  </button>
                  <button className="primary" onClick={() => void handleSaveSelected()}>
                    Save mock
                  </button>
                </div>
              </div>

              <div className="form-grid">
                <label>
                  Name
                  <input value={selectedMock.name} onChange={(event) => updateSelectedMock({ name: event.target.value })} />
                </label>
                <label>
                  Protocol
                  <select value={selectedMock.protocol} onChange={(event) => updateSelectedMock({ protocol: event.target.value as MockProtocol })}>
                    <option value="rest">REST</option>
                    <option value="graphql">GraphQL</option>
                  </select>
                </label>
                <label>
                  Port
                  <input
                    type="number"
                    value={selectedMock.port ?? ''}
                    onChange={(event) => updateSelectedMock({ port: event.target.value ? Number(event.target.value) : undefined })}
                  />
                </label>
                <label>
                  Latency ms
                  <input
                    type="number"
                    value={selectedMock.latencyMs}
                    onChange={(event) => updateSelectedMock({ latencyMs: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Error rate
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={selectedMock.errorRate}
                    onChange={(event) => updateSelectedMock({ errorRate: Number(event.target.value) })}
                  />
                </label>
                <label className="stretch">
                  Description
                  <input value={selectedMock.description ?? ''} onChange={(event) => updateSelectedMock({ description: event.target.value })} />
                </label>
              </div>

              <div className="endpoint-list">
                {selectedMock.endpoints.map((endpoint) => {
                  const isSelected = selectedEndpointId === endpoint.id;
                  return (
                    <section key={endpoint.id} className={`endpoint-card ${isSelected ? 'selected' : ''}`}>
                      <button
                        className="endpoint-head"
                        onClick={() => setSelectedEndpointId(isSelected ? null : endpoint.id)}
                      >
                        <span>
                          {endpoint.method} {endpoint.path}
                        </span>
                        <span>{endpoint.statusCode}</span>
                      </button>
                      {isSelected ? (
                        <div className="endpoint-editor">
                          <div className="form-grid compact">
                            <label>
                              Name
                              <input value={endpoint.name} onChange={(event) => updateEndpoint(endpoint.id, { name: event.target.value })} />
                            </label>
                            <label>
                              Method
                              <select value={endpoint.method} onChange={(event) => updateEndpoint(endpoint.id, { method: event.target.value })}>
                                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].map((method) => (
                                  <option key={method} value={method}>
                                    {method}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              Path
                              <input value={endpoint.path} onChange={(event) => updateEndpoint(endpoint.id, { path: event.target.value })} />
                            </label>
                            <label>
                              Status
                              <input
                                type="number"
                                value={endpoint.statusCode}
                                onChange={(event) => updateEndpoint(endpoint.id, { statusCode: Number(event.target.value) })}
                              />
                            </label>
                            <label>
                              Latency
                              <input
                                type="number"
                                value={endpoint.latencyMs}
                                onChange={(event) => updateEndpoint(endpoint.id, { latencyMs: Number(event.target.value) })}
                              />
                            </label>
                            <label>
                              Error rate
                              <input
                                type="number"
                                min="0"
                                max="1"
                                step="0.05"
                                value={endpoint.errorRate}
                                onChange={(event) => updateEndpoint(endpoint.id, { errorRate: Number(event.target.value) })}
                              />
                            </label>
                          </div>

                          <label>
                            Request headers
                            <textarea
                              value={jsonPretty(endpoint.requestHeaders)}
                              onChange={(event) => {
                                try {
                                  updateEndpoint(endpoint.id, { requestHeaders: JSON.parse(event.target.value) });
                                } catch {
                                  setMessage('Request headers must be valid JSON.');
                                }
                              }}
                            />
                          </label>
                          <label>
                            Request schema
                            <textarea
                              value={jsonPretty(endpoint.requestBodySchema)}
                              onChange={(event) => {
                                try {
                                  updateEndpoint(endpoint.id, { requestBodySchema: parseJsonInput(event.target.value) });
                                } catch {
                                  setMessage('Request schema must be valid JSON.');
                                }
                              }}
                            />
                          </label>
                          <label>
                            Response schema
                            <textarea
                              value={jsonPretty(endpoint.responseSchema)}
                              onChange={(event) => {
                                try {
                                  updateEndpoint(endpoint.id, { responseSchema: parseJsonInput(event.target.value) });
                                } catch {
                                  setMessage('Response schema must be valid JSON.');
                                }
                              }}
                            />
                          </label>
                          <label>
                            Response example
                            <textarea
                              value={jsonPretty(endpoint.responseExample)}
                              onChange={(event) => {
                                try {
                                  updateEndpoint(endpoint.id, { responseExample: parseJsonInput(event.target.value) });
                                } catch {
                                  setMessage('Response example must be valid JSON.');
                                }
                              }}
                            />
                          </label>
                          <div className="endpoint-actions">
                            <button className="secondary" onClick={() => void handleRowSeed(endpoint)}>
                              Seed data
                            </button>
                            <button className="danger" onClick={() => removeEndpoint(endpoint.id)}>
                              Remove endpoint
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            </article>

            <article className="panel inspector">
              <h2>Live Inspector</h2>
              <div className="inspector-block">
                <div className="inspector-row">
                  <span>Status</span>
                  <strong className={`status ${selectedMock.status}`}>{selectedMock.status}</strong>
                </div>
                <div className="inspector-row">
                  <span>Port</span>
                  <strong>{selectedMock.port ?? 'not assigned'}</strong>
                </div>
                <div className="inspector-row">
                  <span>Endpoints</span>
                  <strong>{selectedMock.endpoints.length}</strong>
                </div>
              </div>

              {selectedEndpoint ? (
                <div className="inspector-block">
                  <h3>{selectedEndpoint.name}</h3>
                  <div className="mono">{selectedEndpoint.method} {selectedEndpoint.path}</div>
                  <div className="inspector-row">
                    <span>Table</span>
                    <strong>{selectedEndpoint.tableName || 'pending save'}</strong>
                  </div>
                  <div className="inspector-row">
                    <span>Schema</span>
                    <strong>{selectedEndpoint.responseSchema ? 'yes' : 'no'}</strong>
                  </div>
                </div>
              ) : null}

              <div className="inspector-block">
                <h3>Logs</h3>
                <div className="log-list">
                  {logs.map((log) => (
                    <div key={log.id} className={`log-item ${log.level}`}>
                      <div className="log-head">
                        <strong>{log.level.toUpperCase()}</strong>
                        <span>{new Date(log.createdAt).toLocaleString()}</span>
                      </div>
                      <div>{log.message}</div>
                    </div>
                  ))}
                </div>
              </div>
            </article>
          </section>
        ) : (
          <section className="panel empty-state">
            <h2>No mock selected</h2>
            <p>Import a definition to create a new local mock, or pick one from the list.</p>
          </section>
        )}

        {message ? <div className="toast">{message}</div> : null}
      </main>
    </div>
  );
}
