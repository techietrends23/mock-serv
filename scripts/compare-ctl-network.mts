const PRODUCT_URL = 'https://nonprod.kmart.com.au/product/rayyan-kitchen-mat-90cm-x-60cm-43473779/';
const API = 'http://127.0.0.1:3002';
const MOCK_ID = 'mock_ru6uwo1j_mrlkrgwn';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}/api${path}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method || 'GET'} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

type NetEntry = {
  operationName?: string;
  matched?: boolean;
  responseStatus?: number;
  looksCount?: number;
  bodyPreview?: string;
  responsePreview?: string;
};

function summarize(label: string, entries: NetEntry[], snap: any) {
  const ctl = entries.filter((e) => /CompleteTheLook/i.test(`${e.operationName || ''}${e.bodyPreview || ''}`));
  return {
    label,
    styleItWith: Boolean(snap.hasStyleItWith),
    wrapperPresent: Boolean(snap.wrapperPresent),
    wrapperImages: snap.wrapperImageCount || 0,
    graphqlOps: entries.map((e) => e.operationName).filter(Boolean),
    ctlCalls: ctl.map((e) => ({
      matched: e.matched,
      status: e.responseStatus,
      looks: e.looksCount,
      requestSnippet: (e.bodyPreview || '').slice(0, 180),
      responseSnippet: (e.responsePreview || '').slice(0, 240)
    }))
  };
}

async function runCase(opts: {
  label: string;
  mockIds: string[];
  forceCompleteTheLookFlag: boolean;
}) {
  await request('/mock-session/stop', { method: 'POST' }).catch(() => null);
  await new Promise((r) => setTimeout(r, 1200));
  await request('/mock-session/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mockIds: opts.mockIds,
      forceCompleteTheLookFlag: opts.forceCompleteTheLookFlag
    })
  });
  await request('/mock-session/navigate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: PRODUCT_URL })
  });
  await new Promise((r) => setTimeout(r, 14000));
  const net = await request<{ entries: NetEntry[] }>('/mock-session/network');
  const snap = await request<any>('/mock-session/page-snapshot', { method: 'POST' });
  return summarize(opts.label, net.entries || [], snap);
}

async function main(): Promise<void> {
  await request(`/mocks/${MOCK_ID}/start`, { method: 'POST' }).catch(() => null);

  const results = {
    A_noMock_noForce: await runCase({
      label: 'A) No mock, natural nonprod (Optimizely flag untouched)',
      mockIds: [],
      forceCompleteTheLookFlag: false
    }),
    B_mock_noForce: await runCase({
      label: 'B) Mock enabled, natural nonprod (same as user: Style it with missing)',
      mockIds: [MOCK_ID],
      forceCompleteTheLookFlag: false
    }),
    C_mock_forceFlag: await runCase({
      label: 'C) Mock enabled + CTL flag forced on',
      mockIds: [MOCK_ID],
      forceCompleteTheLookFlag: true
    }),
    D_noMock_forceFlag: await runCase({
      label: 'D) No mock + CTL flag forced on (real API CTL response)',
      mockIds: [],
      forceCompleteTheLookFlag: true
    })
  };

  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
