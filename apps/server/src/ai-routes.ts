import type { FastifyInstance } from 'fastify';
import type { CapturedCall, MockDefinition } from '@mock-serv/core';
import { MockService, requestGraphqlOperationName } from '@mock-serv/core';
import { createMockFromCalls, sanitizePath } from './capture-mock-factory.ts';
import { getMockSessionNetworkEntries } from './test-browser.ts';

type ScopeBody = {
  requirement: string;
  sessionId?: string;
  domains?: string[];
};

type CreatePlanBody = {
  sessionId?: string;
  autoWire?: boolean;
  plan: MockAnalysisPlan;
};

type LlamaChatResponse = {
  choices?: Array<{
    message?: { content?: string };
    text?: string;
  }>;
};

export type MockAnalysisPlan = {
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
};

export type DiagnoseResult = {
  explanation: string;
  likelyCauses: string[];
  missingOperations?: string[];
  createFromCallIds?: string[];
  adjustExisting?: Array<{ mockId: string; reason: string; suggestedBodyContains?: string }>;
  relatedCallIds?: string[];
  nextSteps: string[];
  warnings?: string[];
};

function callHost(call: CapturedCall): string {
  if (call.host) return call.host;
  try {
    return new URL(call.url).host;
  } catch {
    return '';
  }
}

const CTX_TOKENS = Number(process.env.MOCK_SERV_LLM_CTX || 4096);
const MAX_OUTPUT_TOKENS = 900;
const CHARS_PER_TOKEN = 1.9;
const PROMPT_CHAR_BUDGET = Math.max(
  2000,
  Math.floor((CTX_TOKENS - MAX_OUTPUT_TOKENS - 400) * CHARS_PER_TOKEN)
);
const MAX_CALLS = 40;
const MAX_BODY_CHARS = 280;
const MAX_NETWORK = 40;

function compactValue(value: unknown, limit = MAX_BODY_CHARS): unknown {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= limit) return value;
  return `${text.slice(0, limit)}...`;
}

function summarizeCall(call: CapturedCall, bodyLimit: number): Record<string, unknown> {
  const operationName = requestGraphqlOperationName(call.requestBody);
  return {
    id: call.id,
    method: call.method,
    host: callHost(call),
    path: call.path,
    status: call.responseStatus,
    contentType: call.contentType,
    operationName: operationName || undefined,
    requestBody: compactValue(call.requestBody, bodyLimit),
    responseBody: compactValue(call.responseBody, bodyLimit)
  };
}

function summarizeMocks(mocks: MockDefinition[]): Array<Record<string, unknown>> {
  return mocks.slice(0, 30).map((mock) => ({
    id: mock.id,
    name: mock.name,
    status: mock.status,
    sourceRef: mock.sourceRef,
    proxyEnabled: mock.proxyEnabled,
    endpoints: mock.endpoints.map((endpoint) => ({
      id: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      matchRules: endpoint.matchRules,
      statusCode: endpoint.statusCode,
      hasResponseExample: endpoint.responseExample !== undefined
    }))
  }));
}

function summarizeNetwork(): Array<Record<string, unknown>> {
  return getMockSessionNetworkEntries()
    .slice(-MAX_NETWORK)
    .map((entry) => ({
      method: entry.method,
      url: entry.url,
      matched: entry.matched,
      mockId: entry.mockId,
      operationName: entry.operationName,
      responseStatus: entry.responseStatus,
      looksCount: entry.looksCount,
      bodyPreview: entry.bodyPreview,
      responsePreview: entry.responsePreview
    }));
}

function fitPrompt(build: (count: number, bodyLimit: number) => string): string {
  let count = MAX_CALLS;
  let bodyLimit = MAX_BODY_CHARS;
  let prompt = build(count, bodyLimit);
  while (prompt.length > PROMPT_CHAR_BUDGET && count > 1) {
    count = Math.max(1, Math.floor(count * 0.7));
    prompt = build(count, bodyLimit);
  }
  while (prompt.length > PROMPT_CHAR_BUDGET && bodyLimit > 60) {
    bodyLimit = Math.floor(bodyLimit / 2);
    prompt = build(count, bodyLimit);
  }
  if (prompt.length > PROMPT_CHAR_BUDGET) {
    prompt = `${prompt.slice(0, PROMPT_CHAR_BUDGET)}\n... (truncated to fit local model context)`;
  }
  return prompt;
}

function requireLlmBaseUrl(): string {
  const baseUrl = process.env.MOCK_SERV_LLM_BASE_URL;
  if (!baseUrl) throw new Error('Local LLM is not running. Start the app with npm run dev and ensure llama-server starts.');
  return baseUrl;
}

async function chatJson(system: string, user: string): Promise<string> {
  const baseUrl = requireLlmBaseUrl();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MOCK_SERV_LLM_MODEL_NAME || 'local-model',
      temperature: 0.1,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Local LLM request failed (${response.status}). ${text}`);
  }
  const payload = (await response.json()) as LlamaChatResponse;
  return payload.choices?.[0]?.message?.content || payload.choices?.[0]?.text || '';
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] || trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('LLM did not return valid JSON.');
  }
}

function resolveScopedCalls(
  repo: any,
  body: ScopeBody
): { sessionId: string; calls: CapturedCall[]; domains: string[]; allCalls: CapturedCall[] } {
  if (!body.requirement?.trim()) throw new Error('Tell the assistant what you need.');
  const sessions = repo.listCaptureSessions?.() ?? [];
  const sessionId = body.sessionId || sessions[0]?.id;
  if (!sessionId) throw new Error('No capture session found.');

  const domains = Array.from(new Set((body.domains ?? []).filter(Boolean)));
  const domainSet = new Set(domains);
  const allCalls = (repo.listCapturedCalls?.(sessionId) ?? []) as CapturedCall[];
  const calls = domainSet.size ? allCalls.filter((call) => domainSet.has(callHost(call))) : allCalls;
  if (!calls.length) throw new Error('No captured traffic matches the current assistant scope.');
  return { sessionId, calls, domains, allCalls };
}

function normalizeAnalysisPlan(raw: any, validCallIds: Set<string>): MockAnalysisPlan {
  const createMocks = Array.isArray(raw?.createMocks)
    ? raw.createMocks
        .map((item: any) => ({
          name: typeof item?.name === 'string' ? item.name : undefined,
          fromCallIds: Array.isArray(item?.fromCallIds)
            ? item.fromCallIds.filter((id: unknown) => typeof id === 'string' && validCallIds.has(id))
            : [],
          notes: typeof item?.notes === 'string' ? item.notes : undefined
        }))
        .filter((item: { fromCallIds: string[] }) => item.fromCallIds.length > 0)
    : [];

  const relatedCallIds = Array.isArray(raw?.relatedCallIds)
    ? raw.relatedCallIds.filter((id: unknown) => typeof id === 'string' && validCallIds.has(id))
    : [];

  const deleteDomains = Array.isArray(raw?.deleteDomains)
    ? raw.deleteDomains.filter((domain: unknown) => typeof domain === 'string' && domain.trim())
    : [];

  const warnings = Array.isArray(raw?.warnings) ? raw.warnings.filter((w: unknown) => typeof w === 'string') : [];
  const nextSteps = Array.isArray(raw?.nextSteps) ? raw.nextSteps.filter((w: unknown) => typeof w === 'string') : [];

  return {
    explanation: typeof raw?.explanation === 'string' ? raw.explanation : 'No explanation provided.',
    deleteDomains,
    createMocks,
    relatedCallIds,
    warnings,
    nextSteps
  };
}

function normalizeDiagnose(raw: any, validCallIds: Set<string>, mockIds: Set<string>): DiagnoseResult {
  return {
    explanation: typeof raw?.explanation === 'string' ? raw.explanation : 'No explanation provided.',
    likelyCauses: Array.isArray(raw?.likelyCauses)
      ? raw.likelyCauses.filter((item: unknown) => typeof item === 'string')
      : [],
    missingOperations: Array.isArray(raw?.missingOperations)
      ? raw.missingOperations.filter((item: unknown) => typeof item === 'string')
      : [],
    createFromCallIds: Array.isArray(raw?.createFromCallIds)
      ? raw.createFromCallIds.filter((id: unknown) => typeof id === 'string' && validCallIds.has(id))
      : [],
    adjustExisting: Array.isArray(raw?.adjustExisting)
      ? raw.adjustExisting
          .map((item: any) => ({
            mockId: typeof item?.mockId === 'string' ? item.mockId : '',
            reason: typeof item?.reason === 'string' ? item.reason : '',
            suggestedBodyContains:
              typeof item?.suggestedBodyContains === 'string' ? item.suggestedBodyContains : undefined
          }))
          .filter((item: { mockId: string; reason: string }) => item.mockId && mockIds.has(item.mockId) && item.reason)
      : [],
    relatedCallIds: Array.isArray(raw?.relatedCallIds)
      ? raw.relatedCallIds.filter((id: unknown) => typeof id === 'string' && validCallIds.has(id))
      : [],
    nextSteps: Array.isArray(raw?.nextSteps)
      ? raw.nextSteps.filter((item: unknown) => typeof item === 'string')
      : [],
    warnings: Array.isArray(raw?.warnings) ? raw.warnings.filter((item: unknown) => typeof item === 'string') : []
  };
}

function suggestionPrompt(requirement: string, calls: CapturedCall[]): string {
  return fitPrompt((count, bodyLimit) =>
    [
      'You are a local mock-service assistant for a developer.',
      'Analyze captured HTTP traffic and suggest what mocks or cleanup actions the user should create.',
      'Be practical and concise. Prefer bullet points.',
      'When useful, include suggested method, path, status code, response shape, and domains to ignore/delete.',
      'Do not claim you changed the app. You only provide suggestions.',
      '',
      `User requirement: ${requirement}`,
      '',
      `Captured traffic summary (${calls.length} calls total, first ${count} included):`,
      JSON.stringify(
        calls.slice(0, count).map((call) => summarizeCall(call, bodyLimit)),
        null,
        2
      )
    ].join('\n')
  );
}

function analyzePrompt(requirement: string, calls: CapturedCall[], mocks: MockDefinition[]): string {
  return fitPrompt((count, bodyLimit) =>
    [
      'You analyze captured HTTP traffic and return a structured mock plan as JSON only.',
      'Prefer grounding mocks in real captured call ids (fromCallIds). Do not invent response bodies.',
      'For GraphQL shared paths, recommend operation-specific mocks via those call ids (match rules are applied automatically).',
      'If the user goal depends on a call that never appears in traffic, say so in warnings/nextSteps.',
      'Return ONLY JSON matching:',
      '{',
      '  "explanation": string,',
      '  "deleteDomains": string[],',
      '  "createMocks": [{ "name"?: string, "fromCallIds": string[], "notes"?: string }],',
      '  "relatedCallIds": string[],',
      '  "warnings": string[],',
      '  "nextSteps": string[]',
      '}',
      '',
      `User requirement: ${requirement}`,
      '',
      `Existing mocks: ${JSON.stringify(summarizeMocks(mocks))}`,
      '',
      `Captured traffic (${calls.length} total, first ${count} included):`,
      JSON.stringify(
        calls.slice(0, count).map((call) => summarizeCall(call, bodyLimit)),
        null,
        2
      )
    ].join('\n')
  );
}

function diagnosePrompt(
  requirement: string,
  calls: CapturedCall[],
  mocks: MockDefinition[],
  network: Array<Record<string, unknown>>
): string {
  return fitPrompt((count, bodyLimit) =>
    [
      'You diagnose why a mocked browser flow is broken.',
      'Use captured traffic, existing mocks, and mock-session network match/miss logs.',
      'Common failure modes: feature never requested, wrong GraphQL operation match, over-broad mock broken other ops, missing postcode/cookies, response shape mismatch.',
      'Return ONLY JSON matching:',
      '{',
      '  "explanation": string,',
      '  "likelyCauses": string[],',
      '  "missingOperations": string[],',
      '  "createFromCallIds": string[],',
      '  "adjustExisting": [{ "mockId": string, "reason": string, "suggestedBodyContains"?: string }],',
      '  "relatedCallIds": string[],',
      '  "nextSteps": string[],',
      '  "warnings": string[]',
      '}',
      '',
      `User symptom / goal: ${requirement}`,
      '',
      `Enabled/available mocks: ${JSON.stringify(summarizeMocks(mocks))}`,
      '',
      `Mock-session network log (recent GraphQL/intercepts): ${JSON.stringify(network)}`,
      '',
      `Captured traffic (${calls.length} total, first ${count} included):`,
      JSON.stringify(
        calls.slice(0, count).map((call) => summarizeCall(call, bodyLimit)),
        null,
        2
      )
    ].join('\n')
  );
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

  server.post<{ Body: ScopeBody }>('/api/ai/suggest', async (request) => {
    const { sessionId, calls, domains } = resolveScopedCalls(repo, request.body);
    const suggestion = await chatJson(
      'You are a careful API mocking assistant. Return clear implementation suggestions.',
      suggestionPrompt(request.body.requirement, calls)
    );
    return {
      suggestion: suggestion || 'No suggestion returned.',
      sessionId,
      analyzedCalls: calls.length,
      domains
    };
  });

  server.post<{ Body: ScopeBody }>('/api/ai/analyze', async (request) => {
    const { sessionId, calls, domains } = resolveScopedCalls(repo, request.body);
    const mocks = service.listMocks();
    const rawText = await chatJson(
      'You output valid JSON only. No markdown prose outside JSON.',
      analyzePrompt(request.body.requirement, calls, mocks)
    );
    const plan = normalizeAnalysisPlan(extractJsonObject(rawText), new Set(calls.map((call) => call.id)));
    return {
      sessionId,
      analyzedCalls: calls.length,
      domains,
      plan,
      raw: rawText
    };
  });

  server.post<{ Body: CreatePlanBody }>('/api/ai/create-from-plan', async (request) => {
    const sessions = repo.listCaptureSessions?.() ?? [];
    const sessionId = request.body.sessionId || sessions[0]?.id;
    if (!sessionId) throw new Error('No capture session found.');
    const plan = request.body.plan;
    if (!plan?.createMocks?.length) throw new Error('Plan has no createMocks entries.');

    const allCalls = (repo.listCapturedCalls?.(sessionId) ?? []) as CapturedCall[];
    const byId = new Map(allCalls.map((call) => [call.id, call]));
    const created: MockDefinition[] = [];
    const skipped: Array<{ reason: string; fromCallIds: string[] }> = [];

    for (const item of plan.createMocks) {
      const calls = (item.fromCallIds || [])
        .map((id) => byId.get(id))
        .filter((call): call is CapturedCall => Boolean(call));
      if (!calls.length) {
        skipped.push({ reason: 'No valid captured call ids', fromCallIds: item.fromCallIds || [] });
        continue;
      }

      const host = callHost(calls[0]!);
      const name =
        item.name?.trim() ||
        (calls.length === 1
          ? `captured_${calls[0]!.method.toLowerCase()}_${sanitizePath(calls[0]!.path)}`
          : `mock_${sanitizePath(host || 'traffic')}`);

      let mock = createMockFromCalls(service, calls, {
        name,
        description: item.notes || `Created from AI plan (${calls.length} call${calls.length === 1 ? '' : 's'})`
      });
      if (request.body.autoWire !== false) {
        mock = await service.startMock(mock.id);
      }
      created.push(mock);
    }

    return {
      sessionId,
      created,
      skipped,
      autoWired: request.body.autoWire !== false
    };
  });

  server.post<{ Body: ScopeBody }>('/api/ai/diagnose', async (request) => {
    const { sessionId, calls, domains, allCalls } = resolveScopedCalls(repo, request.body);
    const mocks = service.listMocks();
    const network = summarizeNetwork();
    const rawText = await chatJson(
      'You output valid JSON only. No markdown prose outside JSON. Be specific about missing requests vs mock mismatches.',
      diagnosePrompt(request.body.requirement, calls, mocks, network)
    );
    const result = normalizeDiagnose(
      extractJsonObject(rawText),
      new Set(allCalls.map((call) => call.id)),
      new Set(mocks.map((mock) => mock.id))
    );

    return {
      sessionId,
      analyzedCalls: calls.length,
      domains,
      networkEntries: network.length,
      diagnosis: result,
      raw: rawText
    };
  });
}
