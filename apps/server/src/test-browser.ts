import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { endpointResponseExample, isCollectionPath, MockService } from '@mock-serv/core';
import type { MockDefinition, MockEndpoint } from '@mock-serv/core';

let browser: any = null;
let context: any = null;
let page: any = null;
let enabledMockIds = new Set<string>();

function browserPidPath(): string {
  return path.resolve(process.cwd(), '.mock-serv-data', 'mock-session-browser.pid');
}

function readRecordedBrowserPid(): number | null {
  const pid = Number(fs.readFileSync(browserPidPath(), 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function removeRecordedBrowserPid(): void {
  fs.rmSync(browserPidPath(), { force: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 1200): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function killRecordedBrowserProcess(): Promise<void> {
  let pid: number | null = null;
  try {
    pid = readRecordedBrowserPid();
  } catch {
    removeRecordedBrowserPid();
    return;
  }

  if (!pid || pid === process.pid) {
    removeRecordedBrowserPid();
    return;
  }

  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
    }
    await waitForProcessExit(pid);
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
    }
  }
  removeRecordedBrowserPid();
}

function recordBrowserProcess(): void {
  const pid = browser?.process?.()?.pid;
  if (!pid) return;
  fs.mkdirSync(path.dirname(browserPidPath()), { recursive: true });
  fs.writeFileSync(browserPidPath(), String(pid));
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function inferTargetUrl(mock: MockDefinition): string {
  if (mock.sourceRef?.startsWith('http')) {
    try {
      return new URL(mock.sourceRef).origin;
    } catch {
    }
  }
  return 'about:blank';
}

function endpointMatches(endpoint: MockEndpoint, requestUrl: URL, method: string): boolean {
  return endpoint.method.toUpperCase() === method.toUpperCase() && normalizePath(endpoint.path) === requestUrl.pathname;
}

function responseHeaders(endpoint: MockEndpoint): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': '*',
    'content-type': typeof endpoint.responseExample === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
  };
}

function responseBody(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function payloadForEndpoint(service: MockService, mock: MockDefinition, endpoint: MockEndpoint): unknown {
  if (endpoint.method.toUpperCase() === 'GET' && isCollectionPath(endpoint.path)) {
    const rows = service.listRows(mock.id, endpoint.id);
    if (rows.length) return rows.map((row) => row.data);
  }
  return endpointResponseExample(endpoint);
}

async function closeBrowserSession(): Promise<void> {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  context = null;
  browser = null;
  page = null;
  await killRecordedBrowserProcess();
}

function enabledMocks(service: MockService): MockDefinition[] {
  return Array.from(enabledMockIds)
    .map((mockId) => service.getMock(mockId))
    .filter((mock): mock is MockDefinition => Boolean(mock));
}

function findMatchingMockEndpoint(
  service: MockService,
  requestUrl: URL,
  method: string
): { mock: MockDefinition; endpoint: MockEndpoint } | null {
  for (const mock of enabledMocks(service)) {
    const endpoint = mock.endpoints.find((candidate) => endpointMatches(candidate, requestUrl, method));
    if (endpoint) return { mock, endpoint };
  }
  return null;
}

async function ensureBrowser(service: MockService): Promise<void> {
  const { chromium } = await import('playwright').catch(() => {
    throw new Error('playwright is not installed. Run npm install and npx playwright install chromium.');
  });

  if (!browser) {
    browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] });
    recordBrowserProcess();
  }

  if (!context) {
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block'
    });
    await context.route('**/*', async (route: any, routeRequest: any) => {
      const url = new URL(routeRequest.url());
      const method = routeRequest.method().toUpperCase();

      if (method === 'OPTIONS') {
        const hasMatchingPath = enabledMocks(service).some((mock) =>
          mock.endpoints.some((candidate) => normalizePath(candidate.path) === url.pathname)
        );
        if (hasMatchingPath) {
          return route.fulfill({
            status: 204,
            headers: {
              'access-control-allow-origin': '*',
              'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
              'access-control-allow-headers': '*'
            },
            body: ''
          });
        }
      }

      const match = findMatchingMockEndpoint(service, url, method);
      if (!match) return route.continue();

      const payload = payloadForEndpoint(service, match.mock, match.endpoint);
      return route.fulfill({
        status: match.endpoint.statusCode || 200,
        headers: responseHeaders(match.endpoint),
        body: responseBody(payload)
      });
    });
  }

  if (!page || page.isClosed()) {
    page = await context.newPage();
  }
}

function sessionStatus(): { ok: true; running: boolean; enabledMockIds: string[]; targetUrl: string } {
  const running = Boolean(browser && context && page && !page.isClosed());
  return {
    ok: true,
    running,
    enabledMockIds: Array.from(enabledMockIds),
    targetUrl: running ? page.url() : 'about:blank'
  };
}

async function reloadSessionPage(): Promise<void> {
  if (!page || page.isClosed() || page.url() === 'about:blank') return;
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
}

export function registerTestBrowserRoutes(server: FastifyInstance, service: MockService): void {
  server.get('/api/mock-session/status', async () => sessionStatus());

  server.put<{ Body: { mockIds?: string[] } }>('/api/mock-session/enabled', async (request) => {
    enabledMockIds = new Set(request.body.mockIds ?? []);
    await reloadSessionPage();
    return sessionStatus();
  });

  server.post<{ Body: { mockIds?: string[] } }>('/api/mock-session/start', async (request) => {
    enabledMockIds = new Set(request.body.mockIds ?? Array.from(enabledMockIds));
    await closeBrowserSession();
    await ensureBrowser(service);
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
    return sessionStatus();
  });

  server.post('/api/mock-session/stop', async () => {
    await closeBrowserSession();
    return sessionStatus();
  });

  server.post<{ Params: { mockId: string }; Body: { url?: string } }>('/api/mocks/:mockId/test-browser', async (request) => {
    const mock = service.getMock(request.params.mockId);
    if (!mock) throw new Error('Mock not found.');
    enabledMockIds = new Set([mock.id]);
    await ensureBrowser(service);

    const targetUrl = request.body.url || inferTargetUrl(mock);
    if (targetUrl !== 'about:blank') {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    return {
      ok: true,
      targetUrl,
      mockedEndpoints: mock.endpoints.map((endpoint) => `${endpoint.method.toUpperCase()} ${endpoint.path}`)
    };
  });

  server.addHook('onClose', async () => {
    await closeBrowserSession();
    enabledMockIds = new Set();
  });
}
