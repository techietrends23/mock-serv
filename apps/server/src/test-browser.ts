import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { endpointResponseExample, graphqlOperationMatches, isCollectionPath, matchesAllRules, MockService } from '@mock-serv/core';
import type { MockDefinition, MockEndpoint } from '@mock-serv/core';

let browser: any = null;
let context: any = null;
let page: any = null;
let enabledMockIds = new Set<string>();
const recentNetwork: Array<{
  at: string;
  method: string;
  url: string;
  matched: boolean;
  mockId?: string;
  bodyPreview?: string;
  operationName?: string;
  responseStatus?: number;
  responsePreview?: string;
  looksCount?: number;
}> = [];

/** When true, PDP JS is rewritten so kosmos_complete_the_look_pdp is on. */
let forceCompleteTheLookFlag = true;

function rememberNetwork(entry: (typeof recentNetwork)[number]): void {
  recentNetwork.push(entry);
  if (recentNetwork.length > 200) recentNetwork.splice(0, recentNetwork.length - 200);
}

export function getMockSessionNetworkEntries(): Array<(typeof recentNetwork)[number]> {
  return recentNetwork.slice(-80);
}

export function clearMockSessionNetworkEntries(): void {
  recentNetwork.length = 0;
}

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

function hostsForMock(mock: MockDefinition): string[] | null {
  if (!mock.sourceRef?.startsWith('http')) return null;
  try {
    return [new URL(mock.sourceRef).host];
  } catch {
    return null;
  }
}

function hostMatchesMock(mock: MockDefinition, requestUrl: URL): boolean {
  const hosts = hostsForMock(mock);
  if (!hosts) return true;
  return hosts.includes(requestUrl.host);
}

function endpointMatches(endpoint: MockEndpoint, requestUrl: URL, method: string, requestBody?: unknown, headers?: Record<string, string>): boolean {
  if (endpoint.method.toUpperCase() !== method.toUpperCase() || normalizePath(endpoint.path) !== requestUrl.pathname) {
    return false;
  }
  if (endpoint.matchRules?.length) {
    return matchesAllRules(endpoint.matchRules, {
      method,
      url: requestUrl.toString(),
      path: requestUrl.pathname,
      queryString: requestUrl.search,
      headers,
      body: requestBody
    });
  }
  // Backward compatible GraphQL operation matching when rules were not saved yet.
  return graphqlOperationMatches(endpoint, requestBody);
}

function responseHeaders(endpoint: MockEndpoint, requestOrigin?: string): Record<string, string> {
  return {
    'access-control-allow-origin': requestOrigin || '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': '*',
    'vary': 'Origin',
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
  method: string,
  requestBody?: unknown,
  headers?: Record<string, string>
): { mock: MockDefinition; endpoint: MockEndpoint } | null {
  for (const mock of enabledMocks(service)) {
    if (!hostMatchesMock(mock, requestUrl)) continue;
    const endpoint = mock.endpoints.find((candidate) =>
      endpointMatches(candidate, requestUrl, method, requestBody, headers)
    );
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
      const origin = routeRequest.headers()['origin'] as string | undefined;
      const rawBody = typeof routeRequest.postData === 'function' ? routeRequest.postData() : undefined;
      let requestBody: unknown = rawBody;
      if (typeof rawBody === 'string') {
        try {
          requestBody = JSON.parse(rawBody);
        } catch {
          requestBody = rawBody;
        }
      }

      if (method === 'OPTIONS') {
        const hasMatchingPath = enabledMocks(service).some(
          (mock) =>
            hostMatchesMock(mock, url) &&
            mock.endpoints.some((candidate) => normalizePath(candidate.path) === url.pathname)
        );
        if (hasMatchingPath) {
          return route.fulfill({
            status: 204,
            headers: {
              'access-control-allow-origin': origin || '*',
              'access-control-allow-credentials': 'true',
              'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
              'access-control-allow-headers': '*',
              vary: 'Origin'
            },
            body: ''
          });
        }
      }

      const match = findMatchingMockEndpoint(
        service,
        url,
        method,
        requestBody,
        routeRequest.headers() as Record<string, string>
      );

      const bodyPreview =
        typeof rawBody === 'string'
          ? rawBody.slice(0, 300)
          : requestBody
            ? JSON.stringify(requestBody).slice(0, 300)
            : undefined;
      const operationName =
        requestBody && typeof requestBody === 'object' && requestBody !== null && 'operationName' in requestBody
          ? String((requestBody as { operationName?: unknown }).operationName || '')
          : undefined;
      const shouldLogNetwork = url.pathname.includes('graphql') || Boolean(operationName);

      if (!match) {
        // Nonprod currently ships with kosmos_complete_the_look_pdp off, so CTL never mounts.
        // Force-enable that flag on the PDP bundle so mock browser sessions can exercise the mock.
        if (
          forceCompleteTheLookFlag &&
          method === 'GET' &&
          /\/pages\/product\//.test(url.pathname) &&
          url.pathname.endsWith('.js')
        ) {
          try {
            const response = await route.fetch();
            const text = await response.text();
            const rewritten = text
              .replace(
                /\[\{enabled:nC\}\]=\(0,e2\.A2\)\(b\.EY\.KOSMOS_COMPLETE_THE_LOOK_PDP\)/g,
                '[{enabled:nC}]=[{enabled:!0}]'
              )
              .replace(
                /\[\{enabled:(\w+)\}\]=\(0,(\w+)\.A2\)\((?:[a-zA-Z0-9_$.]+)\.KOSMOS_COMPLETE_THE_LOOK_PDP\)/g,
                '[{enabled:$1}]=[{enabled:!0}]'
              );
            return route.fulfill({
              status: response.status(),
              headers: {
                ...response.headers(),
                'content-type': 'application/javascript; charset=utf-8'
              },
              body: rewritten
            });
          } catch {
            return route.continue();
          }
        }

        if (shouldLogNetwork && method === 'POST') {
          try {
            const response = await route.fetch();
            const text = await response.text();
            let looksCount: number | undefined;
            try {
              looksCount = JSON.parse(text)?.data?.getCompleteTheLookGMRecommendations?.length;
            } catch {
              // ignore
            }
            rememberNetwork({
              at: new Date().toISOString(),
              method,
              url: url.toString(),
              matched: false,
              bodyPreview,
              operationName: operationName || undefined,
              responseStatus: response.status(),
              responsePreview: text.slice(0, 400),
              looksCount
            });
            return route.fulfill({
              status: response.status(),
              headers: response.headers(),
              body: text
            });
          } catch {
            rememberNetwork({
              at: new Date().toISOString(),
              method,
              url: url.toString(),
              matched: false,
              bodyPreview,
              operationName: operationName || undefined
            });
            return route.continue();
          }
        }

        if (shouldLogNetwork) {
          rememberNetwork({
            at: new Date().toISOString(),
            method,
            url: url.toString(),
            matched: false,
            bodyPreview,
            operationName: operationName || undefined
          });
        }
        return route.continue();
      }

      const payload = payloadForEndpoint(service, match.mock, match.endpoint);
      const body = responseBody(payload);
      let looksCount: number | undefined;
      try {
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
        looksCount = parsed?.data?.getCompleteTheLookGMRecommendations?.length;
      } catch {
        // ignore
      }
      if (shouldLogNetwork) {
        rememberNetwork({
          at: new Date().toISOString(),
          method,
          url: url.toString(),
          matched: true,
          mockId: match.mock.id,
          bodyPreview,
          operationName: operationName || undefined,
          responseStatus: match.endpoint.statusCode || 200,
          responsePreview: body.slice(0, 400),
          looksCount
        });
      }
      return route.fulfill({
        status: match.endpoint.statusCode || 200,
        headers: responseHeaders(match.endpoint, origin),
        body
      });
    });

    // Seed Kmart fulfillment cookies so CompleteTheLookGM query is allowed to fire.
    await context.addCookies([
      {
        name: '__ko_cus_adl_zip',
        value: JSON.stringify({ postalCode: '2000', state: 'NSW', city: 'Sydney', title: 'Sydney 2000 NSW' }),
        domain: '.kmart.com.au',
        path: '/',
        secure: true,
        sameSite: 'Lax'
      },
      {
        name: 'cus_adl_zip',
        value: '2000',
        domain: '.kmart.com.au',
        path: '/',
        secure: true,
        sameSite: 'Lax'
      },
      {
        name: '__country_code_',
        value: 'AU',
        domain: '.kmart.com.au',
        path: '/',
        secure: true,
        sameSite: 'Lax'
      },
      {
        name: '__ko_pdp_complete_the_look__',
        value: 'bottom',
        domain: '.kmart.com.au',
        path: '/',
        secure: true,
        sameSite: 'Lax'
      },
      {
        name: '__ko_pdp_comp_the_look_enabled__',
        value: 'true',
        domain: '.kmart.com.au',
        path: '/',
        secure: true,
        sameSite: 'Lax'
      }
    ]);
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

  server.post<{ Body: { mockIds?: string[]; forceCompleteTheLookFlag?: boolean } }>('/api/mock-session/start', async (request) => {
    enabledMockIds = new Set(request.body.mockIds ?? Array.from(enabledMockIds));
    if (typeof request.body.forceCompleteTheLookFlag === 'boolean') {
      forceCompleteTheLookFlag = request.body.forceCompleteTheLookFlag;
    } else {
      forceCompleteTheLookFlag = enabledMockIds.size > 0;
    }
    await closeBrowserSession();
    await ensureBrowser(service);
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
    return { ...sessionStatus(), forceCompleteTheLookFlag };
  });

  server.put<{ Body: { forceCompleteTheLookFlag?: boolean } }>('/api/mock-session/options', async (request) => {
    if (typeof request.body.forceCompleteTheLookFlag === 'boolean') {
      forceCompleteTheLookFlag = request.body.forceCompleteTheLookFlag;
    }
    return { ...sessionStatus(), ok: true, forceCompleteTheLookFlag };
  });

  server.post('/api/mock-session/stop', async () => {
    await closeBrowserSession();
    return sessionStatus();
  });

  server.post<{ Body: { url: string } }>('/api/mock-session/navigate', async (request) => {
    if (!request.body?.url) throw new Error('url is required');
    await ensureBrowser(service);
    if (!page || page.isClosed()) {
      page = await context.newPage();
    }
    recentNetwork.length = 0;
    await page.goto(request.body.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    return { ...sessionStatus(), ok: true, forceCompleteTheLookFlag };
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

  server.post<{
    Body: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    };
  }>('/api/mock-session/verify-request', async (request) => {
    if (!browser || !context) {
      await ensureBrowser(service);
    }
    if (!page || page.isClosed()) {
      page = await context.newPage();
    }

    const method = (request.body.method || 'GET').toUpperCase();
    const headers = request.body.headers ?? { 'content-type': 'application/json' };
    const result = await page.evaluate(
      async ({
        url,
        method: reqMethod,
        headers: reqHeaders,
        body
      }: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body: unknown;
      }) => {
        const response = await fetch(url, {
          method: reqMethod,
          headers: reqHeaders,
          body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
        });
        const text = await response.text();
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        return {
          status: response.status,
          ok: response.ok,
          headers: Object.fromEntries(response.headers.entries()),
          text,
          json
        };
      },
      {
        url: request.body.url,
        method,
        headers,
        body: request.body.body
      }
    );

    const matched = findMatchingMockEndpoint(service, new URL(request.body.url), method, request.body.body);
    return {
      ok: true,
      matched: matched
        ? {
            mockId: matched.mock.id,
            mockName: matched.mock.name,
            endpoint: `${matched.endpoint.method} ${matched.endpoint.path}`,
            sourceRef: matched.mock.sourceRef
          }
        : null,
      response: result
    };
  });

  server.post<{
    Body: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      title?: string;
    };
  }>('/api/mock-session/verify-page', async (request) => {
    if (!browser || !context) {
      await ensureBrowser(service);
    }
    if (!page || page.isClosed()) {
      page = await context.newPage();
    }

    const method = (request.body.method || 'POST').toUpperCase();
    const headers = request.body.headers ?? { 'content-type': 'application/json' };
    const title = request.body.title || 'Mock Verify Page';

    await page.setContent(`<!doctype html>
<html>
  <body>
    <h1>${title.replace(/[<>&]/g, '')}</h1>
    <div id="status">loading</div>
    <ul id="products"></ul>
  </body>
</html>`);

    const result = await page.evaluate(
      async ({
        url,
        method: reqMethod,
        headers: reqHeaders,
        body
      }: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body: unknown;
      }) => {
        const status = document.getElementById('status');
        const list = document.getElementById('products');
        try {
          const response = await fetch(url, {
            method: reqMethod,
            headers: reqHeaders,
            body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
          });
          const json = await response.json();
          const looks = json?.data?.getCompleteTheLookGMRecommendations || [];
          const products = looks.flatMap((look: any) => (look.products || []).map((product: any) => product.value)).filter(Boolean);
          if (status) status.textContent = response.ok ? `loaded:${products.length}` : `failed:${response.status}`;
          if (list) {
            list.innerHTML = '';
            for (const name of products) {
              const li = document.createElement('li');
              li.textContent = String(name);
              list.appendChild(li);
            }
          }
          return {
            statusText: status?.textContent || '',
            products,
            looksCount: Array.isArray(looks) ? looks.length : 0,
            httpStatus: response.status
          };
        } catch (error) {
          if (status) status.textContent = `error:${String(error)}`;
          return {
            statusText: status?.textContent || '',
            products: [] as string[],
            looksCount: 0,
            httpStatus: 0,
            error: String(error)
          };
        }
      },
      {
        url: request.body.url,
        method,
        headers,
        body: request.body.body
      }
    );

    const screenshotDir = path.resolve(process.cwd(), '.mock-serv-data');
    fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, 'verify-page.png');
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

    const matched = findMatchingMockEndpoint(service, new URL(request.body.url), method, request.body.body);
    return {
      ok: Boolean(result.statusText.startsWith('loaded:') && result.products.length),
      matched: matched
        ? {
            mockId: matched.mock.id,
            mockName: matched.mock.name,
            endpoint: `${matched.endpoint.method} ${matched.endpoint.path}`,
            sourceRef: matched.mock.sourceRef
          }
        : null,
      page: result,
      screenshotPath
    };
  });

  server.get('/api/mock-session/network', async () => ({
    ok: true,
    count: recentNetwork.length,
    entries: getMockSessionNetworkEntries()
  }));

  server.post('/api/mock-session/network/clear', async () => {
    clearMockSessionNetworkEntries();
    return { ok: true, count: 0 };
  });

  server.post<{ Body: { postcode?: string; country?: string } }>('/api/mock-session/set-fulfillment', async (request) => {
    if (!context) {
      await ensureBrowser(service);
    }
    const postcode = request.body?.postcode || '2000';
    const country = request.body?.country || 'AU';
    await context.addCookies([
      {
        name: 'postcode',
        value: postcode,
        domain: '.kmart.com.au',
        path: '/',
        secure: true,
        sameSite: 'Lax'
      },
      {
        name: 'fulfillmentPostcode',
        value: postcode,
        domain: '.kmart.com.au',
        path: '/',
        secure: true,
        sameSite: 'Lax'
      },
      {
        name: 'selectedPostcode',
        value: postcode,
        domain: '.kmart.com.au',
        path: '/',
        secure: true,
        sameSite: 'Lax'
      },
      {
        name: 'country',
        value: country,
        domain: '.kmart.com.au',
        path: '/',
        secure: true,
        sameSite: 'Lax'
      }
    ]);
    if (page && !page.isClosed()) {
      await page
        .evaluate(
          ({ postcode: pc, country: cty }: { postcode: string; country: string }) => {
            try {
              localStorage.setItem('postcode', pc);
              localStorage.setItem('fulfillmentPostcode', pc);
              localStorage.setItem('selectedPostcode', pc);
              localStorage.setItem('userSelectedPostcode', pc);
              localStorage.setItem('country', cty);
              sessionStorage.setItem('postcode', pc);
              sessionStorage.setItem('fulfillmentPostcode', pc);
            } catch {
              // ignore storage errors
            }
          },
          { postcode, country }
        )
        .catch(() => {});
    }
    return { ok: true, postcode, country };
  });

  server.post<{ Body: { expression?: string; script?: string; arg?: unknown } }>('/api/mock-session/evaluate', async (request) => {
    if (!page || page.isClosed()) {
      return { ok: false, running: false, message: 'Mock browser session is not running.' };
    }
    const expression = request.body.expression || request.body.script;
    if (!expression) {
      return { ok: false, message: 'expression is required' };
    }
    try {
      // eslint-disable-next-line no-new-func
      const result = await page.evaluate(
        // expression is trusted (local API only) — used for diagnostics
        new Function('arg', `return (${expression});`) as any,
        request.body.arg
      );
      return { ok: true, result };
    } catch (error) {
      // Prefer page.evaluate with function body when expression isn't a pure Expression
      try {
        const result = await page.evaluate(
          new Function('arg', String(expression)) as any,
          request.body.arg
        );
        return { ok: true, result };
      } catch (inner) {
        return {
          ok: false,
          error: String(error),
          inner: String(inner)
        };
      }
    }
  });

  server.post<{ Body: { cookies?: Array<Record<string, unknown>>; initScript?: string } }>(
    '/api/mock-session/prepare-kmart',
    async (request) => {
      if (!context) {
        await ensureBrowser(service);
      }

      const postcodePayload = JSON.stringify({
        postalCode: '2000',
        state: 'NSW',
        city: 'Sydney',
        title: 'Sydney 2000 NSW'
      });

      const cookies = [
        {
          name: '__ko_cus_adl_zip',
          value: postcodePayload,
          domain: '.kmart.com.au',
          path: '/',
          secure: true,
          sameSite: 'Lax' as const
        },
        {
          name: 'cus_adl_zip',
          value: '2000',
          domain: '.kmart.com.au',
          path: '/',
          secure: true,
          sameSite: 'Lax' as const
        },
        {
          name: '__country_code_',
          value: 'AU',
          domain: '.kmart.com.au',
          path: '/',
          secure: true,
          sameSite: 'Lax' as const
        },
        {
          name: '__ko_pdp_complete_the_look__',
          value: 'bottom',
          domain: '.kmart.com.au',
          path: '/',
          secure: true,
          sameSite: 'Lax' as const
        },
        {
          name: '__ko_pdp_comp_the_look_enabled__',
          value: 'true',
          domain: '.kmart.com.au',
          path: '/',
          secure: true,
          sameSite: 'Lax' as const
        },
        ...(request.body.cookies || [])
      ];

      await context.addCookies(cookies);

      // Force Optimizely feature decision so CompleteTheLookWrapper mounts.
      await context.addInitScript(() => {
        const forceFeature = (client: any) => {
          if (!client || client.__mockServCtlPatched) return client;
          const wrap = (fn: Function | undefined) =>
            function (this: unknown, featureKey: string, ...rest: unknown[]) {
              if (featureKey === 'kosmos_complete_the_look_pdp') return true;
              return typeof fn === 'function' ? fn.apply(this, [featureKey, ...rest]) : false;
            };
          if (typeof client.isFeatureEnabled === 'function') {
            client.isFeatureEnabled = wrap(client.isFeatureEnabled.bind(client));
          }
          if (typeof client.getFeatureVariableBoolean === 'function') {
            const original = client.getFeatureVariableBoolean.bind(client);
            client.getFeatureVariableBoolean = function (featureKey: string, ...rest: unknown[]) {
              if (featureKey === 'kosmos_complete_the_look_pdp') return true;
              return original(featureKey, ...rest);
            };
          }
          client.__mockServCtlPatched = true;
          return client;
        };

        const patchWindow = () => {
          const w = window as any;
          if (w.optimizelyClientInstance) forceFeature(w.optimizelyClientInstance);
          if (w.optimizely) forceFeature(w.optimizely);
        };

        Object.defineProperty(window, 'optimizelyClientInstance', {
          configurable: true,
          set(value) {
            (window as any).__mockServOptClient = forceFeature(value);
          },
          get() {
            return (window as any).__mockServOptClient;
          }
        });

        document.addEventListener('DOMContentLoaded', patchWindow);
        setInterval(patchWindow, 500);
      });

      if (request.body.initScript) {
        await context.addInitScript(request.body.initScript);
      }

      return { ok: true, cookies: cookies.map((c) => c.name) };
    }
  );

  server.post('/api/mock-session/page-snapshot', async () => {
    if (!page || page.isClosed()) {
      return { ok: false, running: false, message: 'Mock browser session is not running.' };
    }
    const title = await page.title().catch(() => '');
    const url = page.url();
    const dom = await page
      .evaluate(() => {
        const wrapper = document.querySelector('.complete-the-look-wrapper');
        const heading =
          wrapper?.querySelector('h1,h2,h3,h4,[class*="title"],p,span,div') ||
          Array.from(document.querySelectorAll('h1,h2,h3,h4')).find((node) =>
            /^style it with$/i.test((node.textContent || '').trim())
          ) ||
          null;
        const headingText = heading?.textContent?.trim() || null;
        const hasStyleItWith =
          Boolean(wrapper) ||
          Boolean(headingText && /^style it with$/i.test(headingText)) ||
          Boolean(
            Array.from(document.querySelectorAll('.complete-the-look-wrapper, #complete-the-look-carousel')).some(
              (node) => /style it with/i.test(node.textContent || '')
            )
          );
        if (wrapper) wrapper.scrollIntoView({ block: 'center' });
        return {
          bodyText: (document.body?.innerText || '').slice(0, 8000),
          bodyTextLength: (document.body?.innerText || '').length,
          hasStyleItWith,
          styleNodeText: headingText && /style it with/i.test(headingText) ? headingText : hasStyleItWith ? 'Style it with' : null,
          wrapperPresent: Boolean(wrapper),
          wrapperImageCount: wrapper ? wrapper.querySelectorAll('img').length : 0
        };
      })
      .catch(() => ({
        bodyText: '',
        bodyTextLength: 0,
        hasStyleItWith: false,
        styleNodeText: null,
        wrapperPresent: false,
        wrapperImageCount: 0
      }));
    const screenshotDir = path.resolve(process.cwd(), '.mock-serv-data');
    fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, 'product-page.png');
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    return {
      ok: true,
      running: true,
      url,
      title,
      bodyTextLength: dom.bodyTextLength,
      bodyPreview: dom.bodyText.slice(0, 500),
      hasStyleItWith: dom.hasStyleItWith,
      styleNodeText: dom.styleNodeText,
      wrapperPresent: dom.wrapperPresent,
      wrapperImageCount: dom.wrapperImageCount,
      screenshotPath,
      consoleErrors: []
    };
  });

  server.addHook('onClose', async () => {
    await closeBrowserSession();
    enabledMockIds = new Set();
  });
}
