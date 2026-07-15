import type { FastifyInstance } from 'fastify';
import type { CapturedCall } from '@mock-serv/core';
import { MockService } from '@mock-serv/core';

type SuggestionBody = {
  requirement: string;
  sessionId?: string;
  domains?: string[];
};

type LlamaChatResponse = {
  choices?: Array<{
    message?: { content?: string };
    text?: string;
  }>;
};

function callHost(call: CapturedCall): string {
  if (call.host) return call.host;
  try {
    return new URL(call.url).host;
  } catch {
    return '';
  }
}

function compactValue(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= 900) return value;
  return `${text.slice(0, 900)}...`;
}

function summarizeCalls(calls: CapturedCall[]): Array<Record<string, unknown>> {
  return calls.slice(0, 80).map((call) => ({
    method: call.method,
    url: call.url,
    host: callHost(call),
    path: call.path,
    queryString: call.queryString,
    status: call.responseStatus,
    contentType: call.contentType,
    durationMs: Math.round(call.durationMs),
    requestBody: compactValue(call.requestBody),
    responseBody: compactValue(call.responseBody)
  }));
}

function suggestionPrompt(requirement: string, calls: CapturedCall[]): string {
  return [
    'You are a local mock-service assistant for a developer.',
    'Analyze captured HTTP traffic and suggest what mocks or cleanup actions the user should create.',
    'Be practical and concise. Prefer bullet points.',
    'When useful, include suggested method, path, status code, response shape, and domains to ignore/delete.',
    'Do not claim you changed the app. You only provide suggestions.',
    '',
    `User requirement: ${requirement}`,
    '',
    `Captured traffic summary (${calls.length} calls, first ${Math.min(calls.length, 80)} included):`,
    JSON.stringify(summarizeCalls(calls), null, 2)
  ].join('\n');
}

export function registerAiRoutes(server: FastifyInstance, service: MockService): void {
  const repo = service.repository as any;

  server.get('/api/ai/status', async () => {
    const baseUrl = process.env.MOCK_SERV_LLM_BASE_URL;
    if (!baseUrl) return { enabled: false, message: 'Local LLM is not configured.' };
    try {
      const response = await fetch(`${baseUrl}/v1/models`);
      return { enabled: response.ok, baseUrl, message: response.ok ? 'Local LLM is ready.' : 'Local LLM did not respond successfully.' };
    } catch {
      return { enabled: false, baseUrl, message: 'Local LLM is not reachable.' };
    }
  });

  server.post<{ Body: SuggestionBody }>('/api/ai/suggest', async (request) => {
    const baseUrl = process.env.MOCK_SERV_LLM_BASE_URL;
    if (!baseUrl) throw new Error('Local LLM is not running. Start the app with npm run dev and ensure llama-server starts.');
    if (!request.body.requirement?.trim()) throw new Error('Tell the assistant what you need.');

    const sessions = repo.listCaptureSessions?.() ?? [];
    const sessionId = request.body.sessionId || sessions[0]?.id;
    if (!sessionId) throw new Error('No capture session found.');

    const domains = new Set((request.body.domains ?? []).filter(Boolean));
    const allCalls = (repo.listCapturedCalls?.(sessionId) ?? []) as CapturedCall[];
    const calls = domains.size ? allCalls.filter((call) => domains.has(callHost(call))) : allCalls;
    if (!calls.length) throw new Error('No captured traffic matches the current assistant scope.');

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.MOCK_SERV_LLM_MODEL_NAME || 'local-model',
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: 'system', content: 'You are a careful API mocking assistant. Return clear implementation suggestions.' },
          { role: 'user', content: suggestionPrompt(request.body.requirement, calls) }
        ]
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Local LLM request failed (${response.status}). ${text}`);
    }

    const payload = (await response.json()) as LlamaChatResponse;
    const suggestion = payload.choices?.[0]?.message?.content || payload.choices?.[0]?.text || 'No suggestion returned.';
    return {
      suggestion,
      sessionId,
      analyzedCalls: calls.length,
      domains: Array.from(domains)
    };
  });
}
