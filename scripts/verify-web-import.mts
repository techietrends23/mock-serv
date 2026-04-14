import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../apps/server/src/app.ts';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-serv-web-verify-'));
const petstorePath = path.resolve(process.cwd(), 'petstore.yaml');
const petstoreYaml = fs.readFileSync(petstorePath, 'utf8');

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message || `Request to ${url} failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

const server = buildServer({
  dataDir: tempRoot,
  logger: false
});

try {
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  const port = typeof address === 'object' && address ? address.port : 3001;
  const baseUrl = `http://127.0.0.1:${port}`;

  await requestJson(`${baseUrl}/api/import/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sourceType: 'openapi',
      content: petstoreYaml
    })
  });

  const imported = await requestJson<{
    id: string;
    name: string;
    endpoints: Array<unknown>;
  }>(`${baseUrl}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sourceType: 'openapi',
      protocol: 'rest',
      name: 'petstore_web_verify',
      content: petstoreYaml
    })
  });

  const started = await requestJson<{ port: number }>(`${baseUrl}/api/mocks/${encodeURIComponent(imported.id)}/start`, {
    method: 'POST'
  });

  const response = await fetch(`http://127.0.0.1:${started.port}/pet/findByStatus?status=available`);
  const body = await response.json();

  if (response.status !== 200) {
    throw new Error(`Expected 200 from petstore mock, received ${response.status}`);
  }

  if (!Array.isArray(body)) {
    throw new Error('Expected array response from GET /pet/findByStatus');
  }

  console.log(
    JSON.stringify(
      {
        importedMock: {
          id: imported.id,
          name: imported.name,
          endpoints: imported.endpoints.length
        },
        startedPort: started.port,
        httpStatus: response.status,
        responseSample: body[0] ?? null
      },
      null,
      2
    )
  );

  await fetch(`${baseUrl}/api/mocks/${encodeURIComponent(imported.id)}/stop`, { method: 'POST' });
} finally {
  await server.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
