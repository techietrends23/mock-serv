import type { LogEntry, MockDefinition, MockDraft, MockEndpoint } from '@mock-serv/core';

const API_PREFIX = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, init);
  } catch (error) {
    throw new Error('Local API is unavailable. Start the app with `npm run dev` so the browser UI and local backend are both running.');
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message || `Request failed with status ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export interface ImportInput {
  sourceType: 'openapi' | 'curl' | 'postman' | 'har';
  content: string;
  name: string;
  protocol?: 'rest' | 'graphql';
  description?: string;
}

export async function listMocks(): Promise<MockDefinition[]> {
  return request<MockDefinition[]>('/mocks');
}

export async function listLogs(mockId?: string): Promise<LogEntry[]> {
  const query = mockId ? `?mockId=${encodeURIComponent(mockId)}` : '';
  return request<LogEntry[]>(`/logs${query}`);
}

export async function parseImport(input: { sourceType: ImportInput['sourceType']; content: string }): Promise<MockDraft> {
  return request<MockDraft>('/import/parse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
}

export async function importMock(input: ImportInput): Promise<MockDefinition> {
  return request<MockDefinition>('/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
}

export async function saveMock(mock: MockDefinition): Promise<MockDefinition> {
  return request<MockDefinition>(`/mocks/${encodeURIComponent(mock.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mock)
  });
}

export async function deleteMock(mockId: string): Promise<void> {
  return request<void>(`/mocks/${encodeURIComponent(mockId)}`, {
    method: 'DELETE'
  });
}

export async function startMock(mockId: string): Promise<MockDefinition> {
  return request<MockDefinition>(`/mocks/${encodeURIComponent(mockId)}/start`, {
    method: 'POST'
  });
}

export async function stopMock(mockId: string): Promise<MockDefinition | undefined> {
  const result = await request<MockDefinition | null>(`/mocks/${encodeURIComponent(mockId)}/stop`, {
    method: 'POST'
  });
  return result ?? undefined;
}

export async function syncMock(mockId: string): Promise<MockDefinition> {
  return request<MockDefinition>(`/mocks/${encodeURIComponent(mockId)}/sync`, {
    method: 'POST'
  });
}

export async function openMockTestBrowser(mockId: string, url?: string): Promise<{ ok: boolean; targetUrl: string; mockedEndpoints: string[] }> {
  return request<{ ok: boolean; targetUrl: string; mockedEndpoints: string[] }>(`/mocks/${encodeURIComponent(mockId)}/test-browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url })
  });
}

export interface MockSessionStatus {
  ok: boolean;
  running: boolean;
  enabledMockIds: string[];
  targetUrl: string;
}

export async function getMockSessionStatus(): Promise<MockSessionStatus> {
  return request<MockSessionStatus>('/mock-session/status');
}

export async function startMockSession(mockIds: string[]): Promise<MockSessionStatus> {
  return request<MockSessionStatus>('/mock-session/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mockIds })
  });
}

export async function stopMockSession(): Promise<MockSessionStatus> {
  return request<MockSessionStatus>('/mock-session/stop', {
    method: 'POST'
  });
}

export async function setMockSessionEnabled(mockIds: string[]): Promise<MockSessionStatus> {
  return request<MockSessionStatus>('/mock-session/enabled', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mockIds })
  });
}

export async function upsertEndpoint(
  mockId: string,
  endpoint: Partial<MockEndpoint> & Pick<MockEndpoint, 'method' | 'path' | 'name'>
): Promise<MockDefinition> {
  return request<MockDefinition>(`/mocks/${encodeURIComponent(mockId)}/endpoints`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(endpoint)
  });
}

export async function deleteEndpoint(mockId: string, endpointId: string): Promise<MockDefinition> {
  return request<MockDefinition>(`/mocks/${encodeURIComponent(mockId)}/endpoints/${encodeURIComponent(endpointId)}`, {
    method: 'DELETE'
  });
}

export async function listRows(mockId: string, endpointId: string) {
  return request<Array<{ id: string; data: unknown; createdAt: string; updatedAt: string }>>(
    `/mocks/${encodeURIComponent(mockId)}/endpoints/${encodeURIComponent(endpointId)}/rows`
  );
}

export async function seedRows(mockId: string, endpointId: string, rows: Record<string, unknown>[]): Promise<MockDefinition> {
  return request<MockDefinition>(`/mocks/${encodeURIComponent(mockId)}/endpoints/${encodeURIComponent(endpointId)}/rows`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows })
  });
}
