const API_CANDIDATES = ['http://127.0.0.1:3002', 'http://127.0.0.1:3001'];

async function apiBase(): Promise<string> {
  for (const base of API_CANDIDATES) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return base;
    } catch {
      // try next
    }
  }
  throw new Error('Mock Serv API is not reachable on 3001 or 3002');
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}/api${path}`, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method || 'GET'} ${path} failed (${response.status}): ${text}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function hostFromSourceRef(sourceRef?: string): string {
  if (!sourceRef) return '';
  try {
    return new URL(sourceRef).host;
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const base = await apiBase();
  console.log(`Using API ${base}`);

  const mocks = await request<
    Array<{
      id: string;
      name: string;
      status: string;
      port?: number;
      sourceRef?: string;
      endpoints: Array<{ method: string; path: string }>;
    }>
  >(base, '/mocks');

  let mock = mocks.find((item) =>
    item.endpoints.some((endpoint) => endpoint.method.toUpperCase() === 'POST' && endpoint.path.includes('graphql'))
  );
  if (!mock) throw new Error('No GraphQL capture mock found');

  console.log(`Mock: ${mock.name} (${mock.id}) status=${mock.status} port=${mock.port ?? '-'} sourceRef=${mock.sourceRef}`);

  async function probeLocal(port?: number): Promise<boolean> {
    if (!port) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/gateway/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:4000' },
        body: JSON.stringify({ query: '{ __typename }' }),
        signal: AbortSignal.timeout(2000)
      });
      const json = (await response.json()) as any;
      return response.ok && Boolean(json?.data?.getCompleteTheLookGMRecommendations);
    } catch {
      return false;
    }
  }

  if (!(mock.status === 'running' && (await probeLocal(mock.port)))) {
    await request(base, `/mocks/${encodeURIComponent(mock.id)}/stop`, { method: 'POST' }).catch(() => null);
    await request(base, `/mocks/${encodeURIComponent(mock.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: null, status: 'stopped' })
    }).catch(() => null);
    mock = await request(base, `/mocks/${encodeURIComponent(mock.id)}/start`, { method: 'POST' });
    console.log(`Started mock on port ${mock.port}`);
  } else {
    console.log(`Reusing running mock on port ${mock.port}`);
  }

  const endpoint = mock.endpoints.find((item) => item.path.includes('graphql'))!;
  const localUrl = `http://127.0.0.1:${mock.port}${endpoint.path}`;
  const domain = hostFromSourceRef(mock.sourceRef) || 'api.nonprod.kmart.com.au';
  const remoteUrl = `https://${domain}${endpoint.path}`;

  const localResponse = await fetch(localUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:4000'
    },
    body: JSON.stringify({
      operationName: 'GetCompleteTheLookGMRecommendations',
      query: 'query { getCompleteTheLookGMRecommendations { lookId } }',
      variables: {}
    })
  });
  const localJson = (await localResponse.json()) as any;
  const looks = localJson?.data?.getCompleteTheLookGMRecommendations;
  if (!localResponse.ok || !Array.isArray(looks) || !looks.length) {
    throw new Error(`Localhost mock failed: status=${localResponse.status} body=${JSON.stringify(localJson).slice(0, 300)}`);
  }
  console.log(
    `Localhost OK: ${looks.length} looks, first lookId=${looks[0].lookId}, CORS=${localResponse.headers.get('access-control-allow-origin')}`
  );

  const session = await request<{ running: boolean; enabledMockIds: string[] }>(base, '/mock-session/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mockIds: [mock.id] })
  });
  console.log(`Mock session running=${session.running} enabled=${session.enabledMockIds.join(',')}`);

  const verify = await request<{
    matched: { mockId: string; mockName: string; endpoint: string; sourceRef?: string } | null;
    response: { status: number; ok: boolean; json: any; text: string };
  }>(base, '/mock-session/verify-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: remoteUrl,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {
        operationName: 'GetCompleteTheLookGMRecommendations',
        query: 'query GetCompleteTheLookGMRecommendations { getCompleteTheLookGMRecommendations { lookId products { value } } }',
        variables: {}
      }
    })
  });

  if (!verify.matched) {
    throw new Error(`Mock session did not match ${remoteUrl}`);
  }
  const sessionLooks = verify.response.json?.data?.getCompleteTheLookGMRecommendations;
  if (!verify.response.ok || !Array.isArray(sessionLooks) || !sessionLooks.length) {
    throw new Error(
      `Mock session response missing mocked data: status=${verify.response.status} body=${verify.response.text.slice(0, 400)}`
    );
  }

  const productNames = sessionLooks
    .flatMap((look: any) => (look.products ?? []).map((product: any) => product.value))
    .filter(Boolean);
  console.log(`Session intercept OK: matched ${verify.matched.endpoint} on ${verify.matched.sourceRef}`);
  console.log(`Fetch got ${sessionLooks.length} looks and ${productNames.length} products`);
  console.log(`Sample products: ${productNames.slice(0, 3).join(' | ')}`);

  // Wait briefly for tsx reload if verify-page was just added
  let pageVerify: {
    ok: boolean;
    matched: { endpoint: string; sourceRef?: string } | null;
    page: { statusText: string; products: string[]; looksCount: number; httpStatus: number; error?: string };
    screenshotPath?: string;
  } | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      pageVerify = await request(base, '/mock-session/verify-page', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: remoteUrl,
          method: 'POST',
          title: 'Complete The Look Mock Verify',
          headers: { 'content-type': 'application/json' },
          body: {
            operationName: 'GetCompleteTheLookGMRecommendations',
            query: 'query { getCompleteTheLookGMRecommendations { lookId products { value } } }',
            variables: {}
          }
        })
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('404') && !message.includes('not found')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (!pageVerify) throw new Error('verify-page endpoint was not available');
  if (!pageVerify.ok || !pageVerify.page.products.length) {
    throw new Error(
      `Page load verification failed: ${JSON.stringify({ matched: pageVerify.matched, page: pageVerify.page })}`
    );
  }

  console.log(`Page load OK: ${pageVerify.page.statusText} (${pageVerify.page.looksCount} looks)`);
  console.log(`DOM products: ${pageVerify.page.products.slice(0, 4).join(' | ')}`);
  if (pageVerify.screenshotPath) console.log(`Screenshot: ${pageVerify.screenshotPath}`);
  console.log('VERIFY_PASS');
}

main().catch((error) => {
  console.error('VERIFY_FAIL', error);
  process.exitCode = 1;
});
