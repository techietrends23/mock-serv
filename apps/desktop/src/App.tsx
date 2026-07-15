import React, { useEffect, useRef, useState } from 'react';
import {
  deleteMock,
  getMockSessionStatus,
  importMock,
  listMocks,
  listRows,
  parseImport,
  saveMock,
  seedRows,
  setMockSessionEnabled,
  startMock,
  startMockSession,
  stopMock,
  stopMockSession,
  syncMock
} from './api';
import type { MockDefinition, MockEndpoint, MockProtocol, MockSourceType } from '@mock-serv/core';
import CapturePanel from './capture/CapturePanel';

type ImportFormState = {
  sourceType: MockSourceType;
  protocol: MockProtocol;
  name: string;
  description: string;
  content: string;
  fileName: string;
};

type EditorState = MockDefinition | null;
type ResponseViewMode = 'json' | 'raw';
type JsonDrafts = Record<string, string>;

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

function jsonDraftKey(endpointId: string, field: string): string {
  return `${endpointId}:${field}`;
}

function parseDraftKey(key: string): { endpointId: string; field: string } | null {
  const index = key.indexOf(':');
  if (index === -1) return null;
  return { endpointId: key.slice(0, index), field: key.slice(index + 1) };
}

function rawResponse(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function responseDisplay(value: unknown, mode: ResponseViewMode): string {
  if (mode === 'raw') return rawResponse(value);
  return JSON.stringify(value ?? {}, null, 2);
}

function ResponseViewer({
  value,
  draft,
  mode,
  wrap,
  onModeChange,
  onWrapChange,
  onDraftChange,
  onChange,
  onError
}: {
  value: unknown;
  draft?: string;
  mode: ResponseViewMode;
  wrap: boolean;
  onModeChange: (mode: ResponseViewMode) => void;
  onWrapChange: (wrap: boolean) => void;
  onDraftChange: (value: string | undefined) => void;
  onChange: (value: unknown) => void;
  onError: (message: string) => void;
}): React.ReactElement {
  const display = draft ?? responseDisplay(value, mode);
  function commit(nextText: string): void {
    try {
      onChange(mode === 'json' ? parseJsonInput(nextText) : nextText);
      onDraftChange(undefined);
    } catch {
      onError('Response body must be valid JSON before saving. Finish the JSON object/array, then click outside the editor.');
    }
  }
  return (
    <section className="response-viewer">
      <div className="response-toolbar">
        <div className="tabs">
          <button className={mode === 'json' ? 'active' : ''} onClick={() => onModeChange('json')}>JSON</button>
          <button className={mode === 'raw' ? 'active' : ''} onClick={() => onModeChange('raw')}>Raw</button>
        </div>
        <label className="wrap-toggle">
          <input type="checkbox" checked={wrap} onChange={(event) => onWrapChange(event.target.checked)} />
          Wrap lines
        </label>
      </div>
      <textarea
        className={`response-code ${wrap ? 'wrap' : ''}`}
        value={display}
        wrap={wrap ? 'soft' : 'off'}
        spellCheck={false}
        onChange={(event) => onDraftChange(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
      />
    </section>
  );
}

function JsonEditor({
  label,
  value,
  draft,
  onDraftChange,
  onChange,
  onError
}: {
  label: string;
  value: unknown;
  draft?: string;
  onDraftChange: (value: string | undefined) => void;
  onChange: (value: unknown) => void;
  onError: (message: string) => void;
}): React.ReactElement {
  const text = draft ?? jsonPretty(value);
  function commit(nextText: string): void {
    try {
      onChange(parseJsonInput(nextText));
      onDraftChange(undefined);
    } catch {
      onError(`${label} must be valid JSON before saving. Finish the JSON first, then click outside the editor.`);
    }
  }
  return (
    <label>
      {label}
      <textarea
        value={text}
        spellCheck={false}
        onChange={(event) => onDraftChange(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
      />
    </label>
  );
}

export default function App(): React.ReactElement {
  const [imports, setImportForm] = useState<ImportFormState>(emptyImport);
  const [mocks, setMocks] = useState<MockDefinition[]>([]);
  const [selectedMockId, setSelectedMockId] = useState<string | null>(null);
  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);
  const [selectedMock, setSelectedMock] = useState<EditorState>(null);
  const [message, setMessage] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [showCapture, setShowCapture] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [mocksExpanded, setMocksExpanded] = useState(true);
  const [responseViewMode, setResponseViewMode] = useState<ResponseViewMode>('json');
  const [responseWrap, setResponseWrap] = useState(true);
  const [jsonDrafts, setJsonDrafts] = useState<JsonDrafts>({});
  const [enabledMockIds, setEnabledMockIds] = useState<Set<string>>(new Set());
  const [mockSessionRunning, setMockSessionRunning] = useState(false);
  const enabledMocksTouched = useRef(false);

  function setJsonDraft(key: string, value: string | undefined): void {
    setJsonDrafts((current) => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  function mockWithJsonDrafts(): MockDefinition | null {
    const entries = Object.entries(jsonDrafts);
    if (!selectedMock) return null;
    if (!entries.length) return selectedMock;

    const parsedDrafts = new Map<string, Partial<MockEndpoint>>();
    for (const [key, text] of entries) {
      const parsedKey = parseDraftKey(key);
      if (!parsedKey) continue;
      try {
        const value = parsedKey.field === 'responseExample' && responseViewMode === 'raw' ? text : parseJsonInput(text);
        parsedDrafts.set(parsedKey.endpointId, {
          ...parsedDrafts.get(parsedKey.endpointId),
          [parsedKey.field]: parsedKey.field === 'requestHeaders' ? (value ?? {}) : value
        });
      } catch {
        setMessage(`${parsedKey.field} has invalid JSON. Fix it before saving or closing.`);
        return null;
      }
    }

    return {
      ...selectedMock,
      endpoints: selectedMock.endpoints.map((endpoint) => (
        parsedDrafts.has(endpoint.id) ? { ...endpoint, ...parsedDrafts.get(endpoint.id) } : endpoint
      ))
    };
  }

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
    setEnabledMockIds((current) => {
      if (!enabledMocksTouched.current) return new Set(nextMocks.map((mock) => mock.id));
      return new Set(nextMocks.filter((mock) => current.has(mock.id)).map((mock) => mock.id));
    });
    const current = nextSelectedId ? nextMocks.find((mock) => mock.id === nextSelectedId) ?? null : null;
    setSelectedMock(current);
    setSelectedEndpointId((prev) => {
      if (!current) return null;
      const endpoint = current.endpoints.find((item) => item.id === prev) ?? current.endpoints[0];
      return endpoint?.id ?? null;
    });
  }

  useEffect(() => {
    void refreshAll();
    void getMockSessionStatus()
      .then((status) => {
        setMockSessionRunning(status.running);
        if (status.enabledMockIds.length || status.running) {
          enabledMocksTouched.current = true;
          setEnabledMockIds(new Set(status.enabledMockIds));
        }
      })
      .catch(() => {});
  }, []);

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
      setSelectedEndpointId(imported.endpoints[0]?.id ?? null);
      setJsonDrafts({});
      setEditorOpen(true);
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
      const nextEnabled = new Set(Array.from(enabledMockIds).filter((mockId) => mockId !== id));
      setEnabledMockIds(nextEnabled);
      if (mockSessionRunning) await setMockSessionEnabled(Array.from(nextEnabled));
      setSelectedMockId(remaining[0]?.id ?? null);
      if (selectedMockId === id) setEditorOpen(false);
      await refreshAll(remaining[0]?.id);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSelected(): Promise<void> {
    if (!selectedMock) return;
    const mockToSave = mockWithJsonDrafts();
    if (!mockToSave) return;
    setSelectedMock(mockToSave);
    setJsonDrafts({});
    setBusy(true);
    try {
      await saveMock(mockToSave);
      await refreshAll(mockToSave.id);
      setMessage(`Saved ${mockToSave.name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleCloseEditor(): Promise<void> {
    const nextMock = mockWithJsonDrafts();
    if (!nextMock) return;
    setSelectedMock(nextMock);
    setJsonDrafts({});
    setBusy(true);
    try {
      await saveMock(nextMock);
      await refreshAll(nextMock.id);
      setMessage(`Saved ${nextMock.name}`);
      setEditorOpen(false);
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

  async function syncEnabledMocks(nextEnabled: Set<string>, userMessage?: string): Promise<void> {
    enabledMocksTouched.current = true;
    setEnabledMockIds(nextEnabled);
    if (mockSessionRunning) {
      const status = await setMockSessionEnabled(Array.from(nextEnabled));
      setMockSessionRunning(status.running);
    }
    if (userMessage) setMessage(userMessage);
  }

  async function handleToggleMockEnabled(mock: MockDefinition): Promise<void> {
    const nextEnabled = new Set(enabledMockIds);
    if (nextEnabled.has(mock.id)) {
      nextEnabled.delete(mock.id);
      await syncEnabledMocks(nextEnabled, `${mock.name} disabled for the mock session.`);
    } else {
      nextEnabled.add(mock.id);
      await syncEnabledMocks(nextEnabled, `${mock.name} enabled for the mock session.`);
    }
  }

  async function handleEnableAllMocks(): Promise<void> {
    await syncEnabledMocks(new Set(mocks.map((mock) => mock.id)), 'All mocks enabled for the mock session.');
  }

  async function handleDisableAllMocks(): Promise<void> {
    await syncEnabledMocks(new Set(), 'All mocks disabled for the mock session.');
  }

  async function handleStartMockSession(): Promise<void> {
    setBusy(true);
    try {
      const mockIds = enabledMockIds.size || enabledMocksTouched.current ? Array.from(enabledMockIds) : mocks.map((mock) => mock.id);
      if (!enabledMocksTouched.current && mocks.length) {
        enabledMocksTouched.current = true;
        setEnabledMockIds(new Set(mockIds));
      }
      const status = await startMockSession(mockIds);
      setMockSessionRunning(status.running);
      setMessage(`Started a clean mock browser session with ${status.enabledMockIds.length} enabled mock${status.enabledMockIds.length === 1 ? '' : 's'}. Navigate to your app in the opened browser.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleStopMockSession(): Promise<void> {
    setBusy(true);
    try {
      const status = await stopMockSession();
      setMockSessionRunning(status.running);
      setMessage('Stopped the mock browser session.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
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
    setJsonDrafts({});
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
    setJsonDrafts({});
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

        <button className="secondary capture-toggle" onClick={() => {
          setShowCapture(!showCapture);
        }}>
          {showCapture ? 'Hide Traffic Capture' : 'Traffic Capture'}
        </button>

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
              <div className="hint">
                {mocks.length} mock{mocks.length === 1 ? '' : 's'} available · {enabledMockIds.size} enabled
                {mockSessionRunning ? ' · session running' : ''}
              </div>
            </div>
            <div className="mocks-panel-actions">
              <button className="secondary" disabled={busy || !mocks.length} onClick={() => void handleStartMockSession()}>
                Start Mock Session
              </button>
              <button className="secondary" disabled={busy || !mockSessionRunning} onClick={() => void handleStopMockSession()}>
                Stop Session
              </button>
              <button className="secondary slim-button hover-action" disabled={busy || !mocks.length} onClick={() => void handleEnableAllMocks()}>
                Enable all
              </button>
              <button className="secondary slim-button hover-action" disabled={busy || !mocks.length} onClick={() => void handleDisableAllMocks()}>
                Disable all
              </button>
              <button className="secondary slim-button" onClick={() => setMocksExpanded((expanded) => !expanded)}>
                {mocksExpanded ? 'Collapse' : 'Expand'}
              </button>
            </div>
          </div>
          {mocksExpanded && mocks.length ? (
            <div className="mock-grid">
              {mocks.map((mock) => {
                const runtime = mock.status === 'running' && mock.port ? `Port ${mock.port}` : mock.status;
                const mockEnabled = enabledMockIds.has(mock.id);
                return (
                  <button
                    key={mock.id}
                    className={`mock-card ${selectedMockId === mock.id ? 'selected' : ''} ${mockEnabled ? 'enabled' : 'disabled'}`}
                  onClick={() => {
                    setSelectedMockId(mock.id);
                    setSelectedMock(mock);
                    setSelectedEndpointId(mock.endpoints[0]?.id ?? null);
                    setJsonDrafts({});
                    setEditorOpen(true);
                  }}
                  >
                    <div className="mock-head">
                      <strong title={mock.name}>{mock.name}</strong>
                      <span className="mock-badges">
                        <span className={`status ${mockEnabled ? 'enabled' : 'disabled'}`}>{mockEnabled ? 'enabled' : 'off'}</span>
                        <span className={`status ${mock.status}`}>{runtime}</span>
                      </span>
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
                      <span className="action-link" onClick={(event) => {
                        event.stopPropagation();
                        setSelectedMockId(mock.id);
                        setSelectedMock(mock);
                        setSelectedEndpointId(mock.endpoints[0]?.id ?? null);
                        setJsonDrafts({});
                        setEditorOpen(true);
                      }}>
                        Edit
                      </span>
                      <span className="action-link" onClick={(event) => { event.stopPropagation(); void handleToggleMockEnabled(mock); }}>
                        {mockEnabled ? 'Disable' : 'Enable'}
                      </span>
                      <span className="action-link danger" onClick={(event) => { event.stopPropagation(); void handleDelete(mock.id); }}>
                        Delete
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : null}
          {mocksExpanded && !mocks.length ? (
            <div className="mock-empty">No mocks yet. Import a definition to create the first one.</div>
          ) : null}
        </section>

        {showCapture ? (
          <CapturePanel
            onMockCreated={async (mock) => {
              setSelectedMockId(mock.id);
              setSelectedMock(mock);
              setSelectedEndpointId(mock.endpoints[0]?.id ?? null);
              setJsonDrafts({});
              setEditorOpen(true);
              await refreshAll(mock.id);
            }}
          />
        ) : null}

        {selectedMock && editorOpen ? (
          <div className="dialog-overlay" role="dialog" aria-modal="true" aria-label="Mock editor">
            <section className="mock-dialog">
              <div className="dialog-titlebar">
                <div>
                  <h2>Edit Mock</h2>
                  <span>{selectedMock.name}</span>
                </div>
                <button className="secondary" disabled={busy} onClick={() => void handleCloseEditor()}>Save & Close</button>
              </div>
              <div className="dialog-grid">
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

                          <JsonEditor
                            label="Request headers"
                            value={endpoint.requestHeaders}
                            draft={jsonDrafts[jsonDraftKey(endpoint.id, 'requestHeaders')]}
                            onDraftChange={(value) => setJsonDraft(jsonDraftKey(endpoint.id, 'requestHeaders'), value)}
                            onChange={(value) => updateEndpoint(endpoint.id, { requestHeaders: (value ?? {}) as Record<string, string> })}
                            onError={setMessage}
                          />
                          <JsonEditor
                            label="Request schema"
                            value={endpoint.requestBodySchema}
                            draft={jsonDrafts[jsonDraftKey(endpoint.id, 'requestBodySchema')]}
                            onDraftChange={(value) => setJsonDraft(jsonDraftKey(endpoint.id, 'requestBodySchema'), value)}
                            onChange={(value) => updateEndpoint(endpoint.id, { requestBodySchema: value })}
                            onError={setMessage}
                          />
                          <JsonEditor
                            label="Response schema"
                            value={endpoint.responseSchema}
                            draft={jsonDrafts[jsonDraftKey(endpoint.id, 'responseSchema')]}
                            onDraftChange={(value) => setJsonDraft(jsonDraftKey(endpoint.id, 'responseSchema'), value)}
                            onChange={(value) => updateEndpoint(endpoint.id, { responseSchema: value })}
                            onError={setMessage}
                          />
                          <div className="stretch">
                            <div className="field-label">Response example</div>
                            <ResponseViewer
                              value={endpoint.responseExample}
                              draft={jsonDrafts[jsonDraftKey(endpoint.id, 'responseExample')]}
                              mode={responseViewMode}
                              wrap={responseWrap}
                              onModeChange={setResponseViewMode}
                              onWrapChange={setResponseWrap}
                              onDraftChange={(value) => setJsonDraft(jsonDraftKey(endpoint.id, 'responseExample'), value)}
                              onChange={(value) => updateEndpoint(endpoint.id, { responseExample: value })}
                              onError={setMessage}
                            />
                          </div>
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
              </div>
            </section>
          </div>
        ) : null}

        {message ? <div className="toast">{message}</div> : null}
      </main>
    </div>
  );
}
