import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CapturedCall, CaptureSession, MockDefinition } from '@mock-serv/core';
import {
  analyzeMocks,
  createCaptureSession,
  createMockFromCall,
  createMocksFromDomains,
  createMocksFromPlan,
  deleteCapturedCall,
  deleteCaptureSession,
  diagnoseMocks,
  getAiStatus,
  listCapturedCalls,
  listCaptureSessions,
  suggestMocks,
  startCaptureSession,
  stopCaptureSession
} from './api';
import type {
  AiAnalyzeResult,
  AiDiagnoseResult,
  AiStatus,
  AiSuggestionResult,
  MockAnalysisPlan
} from './api';

interface CapturePanelProps {
  onMockCreated?: (mock: MockDefinition) => void | Promise<void>;
  onMocksCreated?: (mocks: MockDefinition[]) => void | Promise<void>;
}

type AssistantMode = 'ask' | 'analyze' | 'diagnose';

type AssistantView =
  | { kind: 'suggest'; data: AiSuggestionResult }
  | { kind: 'analyze'; data: AiAnalyzeResult }
  | { kind: 'diagnose'; data: AiDiagnoseResult };

function formatTime(value: string): string {
  if (!value) return '-';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function callHost(call: CapturedCall): string {
  if (call.host) return call.host;
  try {
    return new URL(call.url).host;
  } catch {
    return '';
  }
}

function callPath(call: CapturedCall): string {
  return `${call.path}${call.queryString ? `?${call.queryString}` : ''}`;
}

function bodyPreview(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'No body';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function callLabel(calls: CapturedCall[], callId: string): string {
  const call = calls.find((item) => item.id === callId);
  if (!call) return callId;
  return `${call.method} ${call.path}`;
}

export default function CapturePanel({ onMockCreated, onMocksCreated }: CapturePanelProps): React.ReactElement {
  const [sessions, setSessions] = useState<CaptureSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [calls, setCalls] = useState<CapturedCall[]>([]);
  const [selectedCallIds, setSelectedCallIds] = useState<Set<string>>(new Set());
  const [newSessionName, setNewSessionName] = useState('');
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set());
  const [domainMenuOpen, setDomainMenuOpen] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [assistantPrompt, setAssistantPrompt] = useState('');
  const [assistantMode, setAssistantMode] = useState<AssistantMode>('analyze');
  const [assistantView, setAssistantView] = useState<AssistantView | null>(null);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refreshSessions = useCallback(async () => {
    const nextSessions = await listCaptureSessions();
    setSessions(nextSessions);
    setSelectedSessionId((current) => current ?? nextSessions[0]?.id ?? null);
  }, []);

  const refreshCalls = useCallback(async (sessionId: string) => {
    const nextCalls = await listCapturedCalls(sessionId);
    setCalls(nextCalls);
    setSelectedCallIds((current) => new Set(nextCalls.filter((call) => current.has(call.id)).map((call) => call.id)));
  }, []);

  useEffect(() => { void refreshSessions(); }, [refreshSessions]);

  useEffect(() => {
    void getAiStatus()
      .then(setAiStatus)
      .catch((error) => setAiStatus({ enabled: false, message: error instanceof Error ? error.message : String(error) }));
  }, []);

  useEffect(() => {
    if (!selectedSessionId) {
      setCalls([]);
      setSelectedCallIds(new Set());
      return;
    }
    void refreshCalls(selectedSessionId);
  }, [selectedSessionId, refreshCalls]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const selectedSession = sessions.find((session) => session.id === selectedSessionId);
    if (selectedSession?.status !== 'running') return;
    const timer = window.setInterval(() => void refreshCalls(selectedSessionId), 2000);
    return () => window.clearInterval(timer);
  }, [refreshCalls, selectedSessionId, sessions]);

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;

  const domains = useMemo(() => {
    return Array.from(new Set(calls.map(callHost).filter(Boolean))).sort();
  }, [calls]);

  const filteredCalls = useMemo(() => {
    if (!selectedDomains.size) return calls;
    return calls.filter((call) => selectedDomains.has(callHost(call)));
  }, [calls, selectedDomains]);

  const selectedVisibleCount = filteredCalls.filter((call) => selectedCallIds.has(call.id)).length;
  const visibleIds = filteredCalls.map((call) => call.id);

  function toggleCall(callId: string): void {
    setSelectedCallIds((current) => {
      const next = new Set(current);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  }

  function toggleDomain(domain: string): void {
    setSelectedDomains((current) => {
      const next = new Set(current);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  }

  function selectAllDomains(): void {
    setSelectedDomains(new Set(domains));
  }

  function clearDomains(): void {
    setSelectedDomains(new Set());
  }

  function selectVisibleCalls(): void {
    setSelectedCallIds(new Set(visibleIds));
  }

  function clearVisibleSelection(): void {
    setSelectedCallIds((current) => {
      const next = new Set(current);
      for (const id of visibleIds) next.delete(id);
      return next;
    });
  }

  async function handleCreateSession(): Promise<void> {
    if (!newSessionName.trim()) return;
    setBusy(true);
    try {
      const session = await createCaptureSession(newSessionName.trim());
      setNewSessionName('');
      await refreshSessions();
      setSelectedSessionId(session.id);
      setMessage(`Session "${session.name}" created.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleStartSession(sessionId: string): Promise<void> {
    setBusy(true);
    try {
      await startCaptureSession(sessionId);
      await refreshSessions();
      setMessage('Capture browser started.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleStopSession(sessionId: string): Promise<void> {
    setBusy(true);
    try {
      await stopCaptureSession(sessionId);
      await refreshSessions();
      setMessage('Capture stopped.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteSession(sessionId: string): Promise<void> {
    setBusy(true);
    try {
      await deleteCaptureSession(sessionId);
      await refreshSessions();
      if (selectedSessionId === sessionId) setSelectedSessionId(null);
      setMessage('Session deleted.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteCall(call: CapturedCall): Promise<void> {
    if (!selectedSessionId) return;
    setBusy(true);
    try {
      await deleteCapturedCall(selectedSessionId, call.id);
      await refreshCalls(selectedSessionId);
      await refreshSessions();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteDomains(): Promise<void> {
    if (!selectedSessionId || !selectedDomains.size) return;
    setBusy(true);
    try {
      const targets = calls.filter((call) => selectedDomains.has(callHost(call)));
      await Promise.all(targets.map((call) => deleteCapturedCall(selectedSessionId, call.id)));
      setSelectedCallIds(new Set());
      await refreshCalls(selectedSessionId);
      await refreshSessions();
      setMessage(`Deleted traffic for ${selectedDomains.size} domain${selectedDomains.size === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteSelected(): Promise<void> {
    if (!selectedSessionId || !selectedCallIds.size) return;
    setBusy(true);
    try {
      await Promise.all(Array.from(selectedCallIds).map((callId) => deleteCapturedCall(selectedSessionId, callId)));
      setSelectedCallIds(new Set());
      await refreshCalls(selectedSessionId);
      await refreshSessions();
      setMessage('Selected traffic deleted.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateMock(call: CapturedCall): Promise<void> {
    if (!selectedSessionId) return;
    setBusy(true);
    try {
      const mock = await createMockFromCall(selectedSessionId, call.id, { autoWire: true });
      await onMockCreated?.(mock);
      setMessage(`Mock "${mock.name}" created and wired to localhost for ${call.host}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleMockSelectedDomains(): Promise<void> {
    if (!selectedSessionId || !selectedDomains.size) return;
    setBusy(true);
    try {
      const result = await createMocksFromDomains(selectedSessionId, Array.from(selectedDomains), { autoWire: true });
      await onMocksCreated?.(result.mocks);
      const domainLabel = result.domains.length ? result.domains.join(', ') : Array.from(selectedDomains).join(', ');
      setMessage(
        `Created ${result.mocks.length} mock${result.mocks.length === 1 ? '' : 's'} for ${domainLabel}. Those domains now resolve to local mocks in the mock browser session.`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleRunAssistant(): Promise<void> {
    if (!assistantPrompt.trim()) {
      setMessage('Tell the assistant what you need.');
      return;
    }
    setAssistantBusy(true);
    try {
      const input = {
        requirement: assistantPrompt,
        sessionId: selectedSessionId ?? undefined,
        domains: Array.from(selectedDomains)
      };
      if (assistantMode === 'ask') {
        setAssistantView({ kind: 'suggest', data: await suggestMocks(input) });
      } else if (assistantMode === 'analyze') {
        setAssistantView({ kind: 'analyze', data: await analyzeMocks(input) });
      } else {
        setAssistantView({ kind: 'diagnose', data: await diagnoseMocks(input) });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAssistantBusy(false);
    }
  }

  async function handleCreateFromPlan(plan: MockAnalysisPlan): Promise<void> {
    if (!plan.createMocks?.length) {
      setMessage('Plan has nothing to create.');
      return;
    }
    setCreateBusy(true);
    try {
      const result = await createMocksFromPlan({
        sessionId: selectedSessionId ?? undefined,
        autoWire: true,
        plan
      });
      await onMocksCreated?.(result.created);
      for (const mock of result.created) await onMockCreated?.(mock);
      setMessage(
        `Created ${result.created.length} mock${result.created.length === 1 ? '' : 's'} from AI plan` +
          (result.skipped.length ? ` (${result.skipped.length} skipped)` : '') +
          '.'
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleCreateFromCallIds(callIds: string[]): Promise<void> {
    await handleCreateFromPlan({
      explanation: 'Created from diagnose suggestion',
      createMocks: [{ fromCallIds: callIds }]
    });
  }

  function handleClearAssistant(): void {
    setAssistantPrompt('');
    setAssistantView(null);
  }

  function highlightCallIds(ids?: string[]): void {
    if (!ids?.length) return;
    setSelectedCallIds(new Set(ids));
    setMessage(`Selected ${ids.length} related call${ids.length === 1 ? '' : 's'} from assistant.`);
  }

  return (
    <section className="panel capture-workspace">
      <div className="capture-header">
        <div>
          <h2>Traffic Capture</h2>
          <div className="hint">Captured calls are shown as full-width rows with hover actions.</div>
        </div>
        <div className="capture-create">
          <input value={newSessionName} onChange={(event) => setNewSessionName(event.target.value)} placeholder="Session name" disabled={busy} />
          <button className="primary" disabled={busy || !newSessionName.trim()} onClick={() => void handleCreateSession()}>
            New Session
          </button>
        </div>
      </div>

      <div className="capture-layout">
        <aside className="capture-rail">
          <div className="rail-title">Sessions</div>
          <div className="capture-sessions">
            {sessions.map((session) => (
              <button
                key={session.id}
                className={`capture-session ${selectedSessionId === session.id ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedSessionId(session.id);
                  setSelectedDomains(new Set());
                  setSelectedCallIds(new Set());
                }}
              >
                <span className="capture-session-head">
                  <strong>{session.name}</strong>
                  <span className={`status ${session.status}`}>{session.status}</span>
                </span>
                <span className="capture-session-meta">{session.callCount} call{session.callCount === 1 ? '' : 's'}</span>
              </button>
            ))}
            {!sessions.length ? <div className="mini-empty">Create a session to start recording traffic.</div> : null}
          </div>
          {selectedSession ? (
            <div className="session-actions">
              {selectedSession.status === 'running' ? (
                <button className="secondary" disabled={busy} onClick={() => void handleStopSession(selectedSession.id)}>Stop</button>
              ) : (
                <button className="secondary" disabled={busy} onClick={() => void handleStartSession(selectedSession.id)}>
                  {selectedSession.status === 'stopped' ? 'Record Again' : 'Start'}
                </button>
              )}
              <button className="danger" disabled={busy} onClick={() => void handleDeleteSession(selectedSession.id)}>Delete Session</button>
            </div>
          ) : null}
        </aside>

        <section className="traffic-list">
          <div className="traffic-toolbar">
            <div>
              <h3>Captured Traffic</h3>
              <span>{filteredCalls.length} of {calls.length} calls</span>
            </div>
            <div className="traffic-tools">
              <div className="domain-filter">
                <div className="field-label">Domains</div>
                <button className="secondary domain-trigger" onClick={() => setDomainMenuOpen((open) => !open)}>
                  {selectedDomains.size ? `${selectedDomains.size} selected` : 'All domains'}
                </button>
                {domainMenuOpen ? (
                  <div className="domain-menu">
                    <label className="domain-option">
                      <input type="checkbox" checked={!selectedDomains.size} onChange={clearDomains} />
                      All domains
                    </label>
                    <div className="domain-menu-actions">
                      <button className="secondary" disabled={!domains.length} onClick={selectAllDomains}>Select all</button>
                      <button className="secondary" disabled={!selectedDomains.size} onClick={clearDomains}>Clear</button>
                    </div>
                    <div className="domain-options">
                      {domains.map((domain) => (
                        <label key={domain} className="domain-option">
                          <input
                            type="checkbox"
                            checked={selectedDomains.has(domain)}
                            onChange={() => toggleDomain(domain)}
                          />
                          <span>{domain}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              <button className="secondary" disabled={!selectedDomains.size || busy} onClick={() => void handleMockSelectedDomains()}>
                Mock Domains
              </button>
              <button className="secondary" disabled={!filteredCalls.length || busy} onClick={selectVisibleCalls}>
                Select Visible
              </button>
              <button className="secondary" disabled={!selectedVisibleCount || busy} onClick={clearVisibleSelection}>
                Clear
              </button>
              <button className="danger" disabled={!selectedDomains.size || busy} onClick={() => void handleDeleteDomains()}>
                Delete Domains
              </button>
              <button className="danger" disabled={!selectedCallIds.size || busy} onClick={() => void handleDeleteSelected()}>
                Delete Selected
              </button>
            </div>
          </div>

          <div className="traffic-list-body">
            {filteredCalls.map((call) => (
              <article key={call.id} className={`traffic-card ${selectedCallIds.has(call.id) ? 'selected' : ''}`}>
                <label className="traffic-check">
                  <input
                    type="checkbox"
                    checked={selectedCallIds.has(call.id)}
                    onChange={() => toggleCall(call.id)}
                  />
                </label>
                <div className="traffic-main">
                  <div className="traffic-line">
                    <span className={`method-pill ${call.method.toLowerCase()}`}>{call.method}</span>
                    <span className={call.responseStatus < 400 ? 'status-code ok' : 'status-code err'}>{call.responseStatus}</span>
                    <span className="traffic-domain">{callHost(call)}</span>
                    <span className="traffic-time">{formatTime(call.timestamp)}</span>
                  </div>
                  <div className="traffic-url">{call.url}</div>
                  <div className="traffic-subline">
                    <span>{callPath(call)}</span>
                    <span>{call.durationMs.toFixed(0)}ms</span>
                    <span>{call.contentType || 'unknown content'}</span>
                  </div>
                  <div className="traffic-preview">
                    <span>Req: {bodyPreview(call.requestBody)}</span>
                    <span>Res: {bodyPreview(call.responseBody)}</span>
                  </div>
                </div>
                <div className="row-actions">
                  <button className="secondary" disabled={busy} onClick={() => void handleCreateMock(call)}>Mock</button>
                  <button className="danger" disabled={busy} onClick={() => void handleDeleteCall(call)}>Delete</button>
                </div>
              </article>
            ))}
            {!filteredCalls.length ? <div className="traffic-empty">No traffic matches this view.</div> : null}
          </div>
        </section>
      </div>

      <button className="assistant-launcher" onClick={() => setAssistantOpen(true)} aria-label="Open Mock Assistant">
        AI
      </button>

      {assistantOpen ? (
        <section className="assistant-window" aria-label="Mock Assistant">
          <div className="assistant-head">
            <div>
              <h3>Mock Assistant</h3>
              <span>{aiStatus?.message ?? 'Checking local LLM...'}</span>
            </div>
            <div className="assistant-head-actions">
              <span className={`assistant-status ${aiStatus?.enabled ? 'ready' : ''}`}>{aiStatus?.enabled ? 'Ready' : 'Offline'}</span>
              <button
                className="secondary slim-button"
                disabled={assistantBusy || (!assistantPrompt && !assistantView)}
                onClick={handleClearAssistant}
              >
                Clear
              </button>
              <button className="secondary slim-button" onClick={() => setAssistantOpen(false)}>Close</button>
            </div>
          </div>

          <div className="assistant-modes">
            <button
              className={`assistant-mode ${assistantMode === 'analyze' ? 'active' : ''}`}
              disabled={assistantBusy}
              onClick={() => setAssistantMode('analyze')}
            >
              Analyze
            </button>
            <button
              className={`assistant-mode ${assistantMode === 'diagnose' ? 'active' : ''}`}
              disabled={assistantBusy}
              onClick={() => setAssistantMode('diagnose')}
            >
              Diagnose
            </button>
            <button
              className={`assistant-mode ${assistantMode === 'ask' ? 'active' : ''}`}
              disabled={assistantBusy}
              onClick={() => setAssistantMode('ask')}
            >
              Ask
            </button>
            <button
              className="assistant-mode create-action"
              disabled={createBusy || assistantView?.kind !== 'analyze' || !assistantView.data.plan.createMocks?.length}
              onClick={() => {
                if (assistantView?.kind === 'analyze') void handleCreateFromPlan(assistantView.data.plan);
              }}
            >
              {createBusy ? 'Creating...' : 'Create mocks'}
            </button>
          </div>

          <div className="assistant-conversation">
            {assistantView?.kind === 'suggest' ? (
              <div className="assistant-message assistant-message-model">
                <div className="assistant-meta">
                  Analyzed {assistantView.data.analyzedCalls} call{assistantView.data.analyzedCalls === 1 ? '' : 's'}
                </div>
                <pre className="assistant-response">{assistantView.data.suggestion}</pre>
              </div>
            ) : null}

            {assistantView?.kind === 'analyze' ? (
              <div className="assistant-message assistant-message-model">
                <div className="assistant-meta">
                  Structured plan from {assistantView.data.analyzedCalls} call{assistantView.data.analyzedCalls === 1 ? '' : 's'}
                </div>
                <p className="assistant-explanation">{assistantView.data.plan.explanation}</p>
                {assistantView.data.plan.warnings?.length ? (
                  <ul className="assistant-list warn">
                    {assistantView.data.plan.warnings.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                {assistantView.data.plan.createMocks?.length ? (
                  <div className="assistant-actions">
                    <div className="assistant-meta">Suggested mocks</div>
                    {assistantView.data.plan.createMocks.map((item, index) => (
                      <div key={`${item.name || 'mock'}-${index}`} className="assistant-card">
                        <strong>{item.name || `Mock group ${index + 1}`}</strong>
                        <div className="assistant-card-meta">
                          {item.fromCallIds.map((id) => callLabel(calls, id)).join(' · ')}
                        </div>
                        {item.notes ? <div className="assistant-card-notes">{item.notes}</div> : null}
                      </div>
                    ))}
                    <button
                      className="primary"
                      disabled={createBusy || !aiStatus?.enabled}
                      onClick={() => void handleCreateFromPlan(assistantView.data.plan)}
                    >
                      {createBusy ? 'Creating...' : `Create ${assistantView.data.plan.createMocks.length} mock(s)`}
                    </button>
                  </div>
                ) : (
                  <div className="assistant-empty">No createMocks entries — try refining the goal.</div>
                )}
                {assistantView.data.plan.deleteDomains?.length ? (
                  <div className="assistant-actions">
                    <div className="assistant-meta">Noise domains to ignore/delete</div>
                    <div className="assistant-tags">
                      {assistantView.data.plan.deleteDomains.map((domain) => (
                        <span key={domain} className="assistant-tag">{domain}</span>
                      ))}
                    </div>
                  </div>
                ) : null}
                {assistantView.data.plan.relatedCallIds?.length ? (
                  <button className="secondary" onClick={() => highlightCallIds(assistantView.data.plan.relatedCallIds)}>
                    Select related calls
                  </button>
                ) : null}
                {assistantView.data.plan.nextSteps?.length ? (
                  <ul className="assistant-list">
                    {assistantView.data.plan.nextSteps.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {assistantView?.kind === 'diagnose' ? (
              <div className="assistant-message assistant-message-model">
                <div className="assistant-meta">
                  Diagnosis using {assistantView.data.analyzedCalls} calls + {assistantView.data.networkEntries} mock-session network event
                  {assistantView.data.networkEntries === 1 ? '' : 's'}
                </div>
                <p className="assistant-explanation">{assistantView.data.diagnosis.explanation}</p>
                {assistantView.data.diagnosis.likelyCauses?.length ? (
                  <ul className="assistant-list warn">
                    {assistantView.data.diagnosis.likelyCauses.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                {assistantView.data.diagnosis.missingOperations?.length ? (
                  <div className="assistant-actions">
                    <div className="assistant-meta">Missing operations / requests</div>
                    <div className="assistant-tags">
                      {assistantView.data.diagnosis.missingOperations.map((item) => (
                        <span key={item} className="assistant-tag">{item}</span>
                      ))}
                    </div>
                  </div>
                ) : null}
                {assistantView.data.diagnosis.createFromCallIds?.length ? (
                  <button
                    className="primary"
                    disabled={createBusy}
                    onClick={() => void handleCreateFromCallIds(assistantView.data.diagnosis.createFromCallIds || [])}
                  >
                    Create mocks for suggested calls
                  </button>
                ) : null}
                {assistantView.data.diagnosis.relatedCallIds?.length ? (
                  <button className="secondary" onClick={() => highlightCallIds(assistantView.data.diagnosis.relatedCallIds)}>
                    Select related calls
                  </button>
                ) : null}
                {assistantView.data.diagnosis.nextSteps?.length ? (
                  <ul className="assistant-list">
                    {assistantView.data.diagnosis.nextSteps.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {!assistantView ? (
              <div className="assistant-empty">
                Analyze returns a structured mock plan. Create applies it from real captured responses. Diagnose uses
                mock-session network hit/miss logs to explain why the UI still fails.
              </div>
            ) : null}
          </div>

          <div className="assistant-compose">
            <textarea
              value={assistantPrompt}
              onChange={(event) => setAssistantPrompt(event.target.value)}
              placeholder={
                assistantMode === 'diagnose'
                  ? 'Example: Style it with never appears on the Rayyan mat PDP when my GraphQL mock is enabled.'
                  : 'Example: I need Style it with / Complete The Look recommendations mocked from captured traffic.'
              }
              disabled={assistantBusy}
            />
            <button
              className="primary"
              disabled={assistantBusy || !assistantPrompt.trim() || !aiStatus?.enabled}
              onClick={() => void handleRunAssistant()}
            >
              {assistantBusy ? 'Thinking...' : assistantMode === 'diagnose' ? 'Diagnose' : assistantMode === 'ask' ? 'Ask' : 'Analyze'}
            </button>
          </div>
        </section>
      ) : null}

      {selectedCallIds.size ? <div className="inline-message">{selectedCallIds.size} selected</div> : null}
      {message ? <div className="inline-message">{message}</div> : null}
    </section>
  );
}
