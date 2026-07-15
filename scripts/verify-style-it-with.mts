const PRODUCT_URL = 'https://nonprod.kmart.com.au/product/rayyan-kitchen-mat-90cm-x-60cm-43473779/';
const API = 'http://127.0.0.1:3002';
const MOCK_ID = 'mock_ru6uwo1j_mrlkrgwn';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}/api${path}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method || 'GET'} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function main(): Promise<void> {
  const mocks = await request<any[]>('/mocks');
  const mock = mocks.find((item) => item.id === MOCK_ID);
  if (!mock) throw new Error(`Mock ${MOCK_ID} not found`);

  console.log('BEFORE', {
    proxyEnabled: mock.proxyEnabled,
    proxyUrl: mock.proxyUrl,
    matchRules: mock.endpoints[0]?.matchRules,
    looks: mock.endpoints[0]?.responseExample?.data?.getCompleteTheLookGMRecommendations?.length
  });

  const edited = {
    ...mock,
    proxyEnabled: true,
    proxyUrl: 'https://api.nonprod.kmart.com.au',
    endpoints: mock.endpoints.map((endpoint: any, index: number) => ({
      ...endpoint,
      orderIndex: index,
      statusCode: 200,
      latencyMs: 0,
      matchRules: [{ target: 'body', operator: 'contains', value: 'GetCompleteTheLookGMRecommendations' }]
    }))
  };

  const saved = await request<any>(`/mocks/${MOCK_ID}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(edited)
  });
  console.log('AFTER save', {
    proxyEnabled: saved.proxyEnabled,
    proxyUrl: saved.proxyUrl,
    matchRules: saved.endpoints[0]?.matchRules,
    looks: saved.endpoints[0]?.responseExample?.data?.getCompleteTheLookGMRecommendations?.length
  });

  await request(`/mocks/${MOCK_ID}/stop`, { method: 'POST' }).catch(() => null);
  const started = await request<any>(`/mocks/${MOCK_ID}/start`, { method: 'POST' });
  console.log('STARTED', { status: started.status, port: started.port });

  // Fresh browser context so PDP JS rewrite + cookies apply
  await request('/mock-session/stop', { method: 'POST' }).catch(() => null);
  await new Promise((r) => setTimeout(r, 1500));
  await request('/mock-session/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mockIds: [MOCK_ID] })
  });
  await request('/mock-session/network/clear', { method: 'POST' }).catch(() => null);
  await request('/mock-session/prepare-kmart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  }).catch(() => null);

  await request(`/mocks/${MOCK_ID}/test-browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: PRODUCT_URL })
  });

  for (let attempt = 1; attempt <= 10; attempt++) {
    await new Promise((r) => setTimeout(r, 4000));
    const net = await request<any>('/mock-session/network');
    const ctl = (net.entries || []).filter((e: any) =>
      /GetCompleteTheLookGMRecommendations|CompleteTheLook/i.test(`${e.operationName || ''}${e.bodyPreview || ''}`)
    );
    const snap = await request<any>('/mock-session/page-snapshot', { method: 'POST' });
    console.log(`T${attempt}`, {
      style: snap.hasStyleItWith,
      wrapper: snap.wrapperPresent,
      images: snap.wrapperImageCount,
      styleText: snap.styleNodeText,
      ctl: ctl.map((e: any) => ({ matched: e.matched, op: e.operationName }))
    });
    if (snap.hasStyleItWith) {
      console.log('VERIFY_PASS: mock re-saved in new format and Style it with is visible');
      console.log('screenshot', snap.screenshotPath);
      return;
    }
  }

  throw new Error('Style it with not visible after mock edit + forced CTL flag + postcode');
}

main().catch((error) => {
  console.error('VERIFY_FAIL', error);
  process.exitCode = 1;
});
