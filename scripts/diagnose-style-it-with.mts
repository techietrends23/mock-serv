import { chromium } from 'playwright';
import { endpointResponseExample, graphqlOperationMatches } from '../packages/core/src/index.ts';

const mocks = await fetch('http://127.0.0.1:3002/api/mocks').then((r) => r.json());
const mock = mocks.find((x) => x.id === 'mock_ru6uwo1j_mrlkrgwn');
if (!mock) throw new Error('mock not found');
const endpoint = mock.endpoints[0];

const ops = [];
const browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
await context.route('**/*', async (route, req) => {
  const url = new URL(req.url());
  const method = req.method().toUpperCase();
  if (url.pathname.includes('graphql') && method === 'POST') {
    let body;
    try {
      body = JSON.parse(req.postData() || '{}');
    } catch {
      body = req.postData();
    }
    const matched = graphqlOperationMatches(endpoint, body);
    ops.push({
      op: body?.operationName,
      matched,
      host: url.host,
      productIds: body?.variables?.input?.productId
    });
    if (matched && url.host.includes('api.nonprod')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': '*'
        },
        body: JSON.stringify(endpointResponseExample(endpoint))
      });
    }
  }
  return route.continue();
});

const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') ops.push({ consoleError: msg.text().slice(0, 400) });
});
page.on('pageerror', (err) => ops.push({ pageError: String(err).slice(0, 400) }));

await page.goto('https://nonprod.kmart.com.au/product/rayyan-kitchen-mat-90cm-x-60cm-43473779/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000
});
await page.waitForTimeout(15000);

const styleCount = await page.locator('text=Style it with').count();
const body = await page.locator('body').innerText();
const mockLooks = endpointResponseExample(endpoint)?.data?.getCompleteTheLookGMRecommendations;

console.log(
  JSON.stringify(
    {
      styleCount,
      hasStyleText: body.includes('Style it with'),
      graphqlOps: ops.filter((o) => o.op || o.consoleError || o.pageError),
      mockLooks: mockLooks?.map((look) => ({ lookId: look.lookId, products: look.products?.length }))
    },
    null,
    2
  )
);
await browser.close();
