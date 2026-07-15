import type { CapturedCall, CaptureSession, MockDefinition } from '@mock-serv/core';

const API_PREFIX = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, init);
  } catch {
    throw new Error('Local API is unavailable');
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message || `Request failed with status ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function createCaptureSession(name: string): Promise<CaptureSession> {
  return request<CaptureSession>('/capture/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name })
  });
}

export async function listCaptureSessions(): Promise<CaptureSession[]> {
  return request<CaptureSession[]>('/capture/sessions');
}

export async function getCaptureSession(sessionId: string): Promise<CaptureSession> {
  return request<CaptureSession>(`/capture/sessions/${encodeURIComponent(sessionId)}`);
}

export async function deleteCaptureSession(sessionId: string): Promise<void> {
  return request<void>(`/capture/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

export async function startCaptureSession(sessionId: string): Promise<CaptureSession> {
  return request<CaptureSession>(`/capture/sessions/${encodeURIComponent(sessionId)}/start`, { method: 'POST' });
}

export async function stopCaptureSession(sessionId: string): Promise<CaptureSession> {
  return request<CaptureSession>(`/capture/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' });
}

export async function navigateCaptureSession(sessionId: string, url: string): Promise<void> {
  return request<void>(`/capture/sessions/${encodeURIComponent(sessionId)}/navigate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url })
  });
}

export async function listCapturedCalls(sessionId: string): Promise<CapturedCall[]> {
  return request<CapturedCall[]>(`/capture/sessions/${encodeURIComponent(sessionId)}/calls`);
}

export async function getCapturedCall(sessionId: string, callId: string): Promise<CapturedCall> {
  return request<CapturedCall>(`/capture/sessions/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(callId)}`);
}

export async function deleteCapturedCall(sessionId: string, callId: string): Promise<void> {
  return request<void>(`/capture/sessions/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(callId)}`, { method: 'DELETE' });
}

export async function createMockFromCall(
  sessionId: string,
  callId: string,
  options?: { name?: string; description?: string; autoWire?: boolean }
): Promise<MockDefinition> {
  return request<MockDefinition>(`/capture/sessions/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(callId)}/mock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options || {})
  });
}

export interface CreateMocksFromDomainsResult {
  mocks: MockDefinition[];
  domains: string[];
  autoWired: boolean;
}

export async function createMocksFromDomains(
  sessionId: string,
  domains: string[],
  options?: { autoWire?: boolean }
): Promise<CreateMocksFromDomainsResult> {
  return request<CreateMocksFromDomainsResult>(`/capture/sessions/${encodeURIComponent(sessionId)}/mocks-from-domains`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domains, autoWire: options?.autoWire })
  });
}

export interface AiStatus {
  enabled: boolean;
  baseUrl?: string;
  message: string;
}

export interface AiSuggestionResult {
  suggestion: string;
  sessionId: string;
  analyzedCalls: number;
  domains: string[];
}

export interface MockAnalysisPlan {
  explanation: string;
  deleteDomains?: string[];
  createMocks?: Array<{
    name?: string;
    fromCallIds: string[];
    notes?: string;
  }>;
  relatedCallIds?: string[];
  warnings?: string[];
  nextSteps?: string[];
}

export interface AiAnalyzeResult {
  sessionId: string;
  analyzedCalls: number;
  domains: string[];
  plan: MockAnalysisPlan;
  raw?: string;
}

export interface AiCreateFromPlanResult {
  sessionId: string;
  created: MockDefinition[];
  skipped: Array<{ reason: string; fromCallIds: string[] }>;
  autoWired: boolean;
}

export interface AiDiagnoseResult {
  sessionId: string;
  analyzedCalls: number;
  domains: string[];
  networkEntries: number;
  diagnosis: {
    explanation: string;
    likelyCauses: string[];
    missingOperations?: string[];
    createFromCallIds?: string[];
    adjustExisting?: Array<{ mockId: string; reason: string; suggestedBodyContains?: string }>;
    relatedCallIds?: string[];
    nextSteps: string[];
    warnings?: string[];
  };
  raw?: string;
}

export async function getAiStatus(): Promise<AiStatus> {
  return request<AiStatus>('/ai/status');
}

export async function suggestMocks(input: { requirement: string; sessionId?: string; domains?: string[] }): Promise<AiSuggestionResult> {
  return request<AiSuggestionResult>('/ai/suggest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
}

export async function analyzeMocks(input: { requirement: string; sessionId?: string; domains?: string[] }): Promise<AiAnalyzeResult> {
  return request<AiAnalyzeResult>('/ai/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
}

export async function createMocksFromPlan(input: {
  sessionId?: string;
  autoWire?: boolean;
  plan: MockAnalysisPlan;
}): Promise<AiCreateFromPlanResult> {
  return request<AiCreateFromPlanResult>('/ai/create-from-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
}

export async function diagnoseMocks(input: { requirement: string; sessionId?: string; domains?: string[] }): Promise<AiDiagnoseResult> {
  return request<AiDiagnoseResult>('/ai/diagnose', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
}
