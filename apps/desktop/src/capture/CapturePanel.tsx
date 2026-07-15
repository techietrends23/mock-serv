import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CapturedCall, CaptureSession, MockDefinition } from '@mock-serv/core';
import {
  createCaptureSession,
  createMockFromCall,
  deleteCapturedCall,
  deleteCaptureSession,
  getCapturedCall,
  listCapturedCalls,
  listCaptureSessions,
  startCaptureSession,
  stopCaptureSession
} from './api';

interface CapturePanelProps {
  onMockCreated?: (mock: MockDefinition) => void | Promise<void>;
}

function jsonPretty(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

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

export default function CapturePanel({ onMockCreated }: CapturePanelProps): React.ReactElement {
  const [sessions, setSessions] = useState<CaptureSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [calls, setCalls] = useState<CapturedCall[]>([]);
  const [selectedCall, setSelectedCall] = useState<CapturedCall | null>(null);
  const [newSessionName, setNewSessionName] = useState('');
  const [domainFilter, setDomainFilter] = useState('all');
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
    setSelectedCall((current) => current ? nextCalls.find((call) => call.id === current.id) ?? current : nextCalls[0] ?? null);
  }, []);

  useEffect(() => { void refreshSessions(); }, [refreshSessions]);

  useEffect(() => {
    if (!selectedSessionId) {
      setCalls([]);
      setSelectedCall(null);
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
    if (domainFilter === 'all') return calls;
    return calls.filter((call) => callHost(call).toLowerCase() === domainFilter.toLowerCase());
  }, [calls, domainFilter]);

  useEffect(() => {
    if (!filteredCalls.length) {
      setSelectedCall(null);
      return;
    }
    setSelectedCall((current) => filteredCalls.find((call) => call.id === current?.id) ?? filteredCalls[0]);
  }, [filteredCalls]);

  async function handleCreateSession(): Promise<void> {
    if (!newSessionName.trim()) {
      setMessage('Enter a session name.');
      return;
    }
    setBusy(true);
    try {
      const session = await createCaptureSession(newSessionName.trim());
      setNewSessionName('');
      await refreshSessions();
      setSelectedSessionId(session.id);
      setMessage('Session ready.');
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
      setMessage('Capture started. A browser window will open.');
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
      await refreshCalls(sessionId);
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
      setSelectedCall(null);
      setCalls([]);
      await refreshSessions();
      if (selectedSessionId === sessionId) setSelectedSessionId(null);
      setMessage('Session deleted.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectCall(call: CapturedCall): Promise<void> {
    if (!selectedSessionId) return;
    setSelectedCall(call);
    try {
      setSelectedCall(await getCapturedCall(selectedSessionId, call.id));
    } catch {
      setMessage('Failed to load traffic details.');
    }
  }

  async function handleDeleteCall(): Promise<void> {
    if (!selectedSessionId || !selectedCall) return;
    setBusy(true);
    try {
      await deleteCapturedCall(selectedSessionId, selectedCall.id);
      setSelectedCall(null);
      await refreshCalls(selectedSessionId);
      await refreshSessions();
      setMessage('Traffic deleted.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateMock(): Promise<void> {
    if (!selectedSessionId || !selectedCall) return;
    setBusy(true);
    try {
      const mock = await createMockFromCall(selectedSessionId, selectedCall.id);
      await onMockCreated?.(mock);
      setMessage(`Mock "${mock.name}" created.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel capture-workspace">
      <div className="capture-header">
        <div>
          <h2>Traffic Capture</h2>
          <div className="hint">Capture, inspect, filter, mock, and delete recorded HTTP calls.</div>
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
                  setDomainFilter('all');
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
            <label>
              Domain
              <select value={domainFilter} onChange={(event) => setDomainFilter(event.target.value)}>
                <option value="all">All domains</option>
                {domains.map((domain) => <option key={domain} value={domain}>{domain}</option>)}
              </select>
            </label>
          </div>
          <div className="traffic-table">
            <div className="traffic-row traffic-row-head">
              <span>Method</span>
              <span>Status</span>
              <span>Domain</span>
              <span>Path</span>
              <span>Time</span>
            </div>
            {filteredCalls.map((call) => (
              <button
                key={call.id}
                className={`traffic-row ${selectedCall?.id === call.id ? 'selected' : ''}`}
                onClick={() => void handleSelectCall(call)}
              >
                <span className={`method-pill ${call.method.toLowerCase()}`}>{call.method}</span>
                <span className={call.responseStatus < 400 ? 'status-code ok' : 'status-code err'}>{call.responseStatus}</span>
                <span className="traffic-domain">{callHost(call)}</span>
                <span className="traffic-path">{call.path}{call.queryString ? `?${call.queryString}` : ''}</span>
                <span>{formatTime(call.timestamp)}</span>
              </button>
            ))}
            {!filteredCalls.length ? <div className="traffic-empty">No traffic matches this view.</div> : null}
          </div>
        </section>

        <section className="traffic-detail">
          <div className="detail-title">
            <div>
              <h3>Call Detail</h3>
              <span>{selectedCall ? `${selectedCall.method} ${selectedCall.path}` : 'Select traffic to inspect it'}</span>
            </div>
            <div className="detail-actions">
              <button className="secondary" disabled={!selectedCall || busy} onClick={() => void handleCreateMock()}>Mock</button>
              <button className="danger" disabled={!selectedCall || busy} onClick={() => void handleDeleteCall()}>Delete</button>
            </div>
          </div>

          {selectedCall ? (
            <div className="detail-body">
              <div className="inspector-block compact-detail">
                <div className="inspector-row"><span>URL</span><strong>{selectedCall.url}</strong></div>
                <div className="inspector-row"><span>Status</span><strong>{selectedCall.responseStatus}</strong></div>
                <div className="inspector-row"><span>Duration</span><strong>{selectedCall.durationMs.toFixed(0)}ms</strong></div>
              </div>
              <label>Request Headers<textarea readOnly value={jsonPretty(selectedCall.requestHeaders)} /></label>
              <label>Request Body<textarea readOnly value={jsonPretty(selectedCall.requestBody)} /></label>
              <label>Response Headers<textarea readOnly value={jsonPretty(selectedCall.responseHeaders)} /></label>
              <label>Response Body<textarea readOnly value={jsonPretty(selectedCall.responseBody)} /></label>
            </div>
          ) : (
            <div className="traffic-empty detail-empty">Select a row to view headers, payloads, and mocking actions.</div>
          )}
        </section>
      </div>

      {message ? <div className="inline-message">{message}</div> : null}
    </section>
  );
}
