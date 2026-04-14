import path from 'node:path';
import { buildServer } from './app.ts';

const host = process.env.MOCK_SERV_HOST ?? '127.0.0.1';
const port = Number(process.env.MOCK_SERV_PORT ?? 3001);
const dataDir = process.env.MOCK_SERV_DATA_DIR ? path.resolve(process.cwd(), process.env.MOCK_SERV_DATA_DIR) : undefined;
const uiDistDir = process.env.MOCK_SERV_UI_DIST ? path.resolve(process.cwd(), process.env.MOCK_SERV_UI_DIST) : undefined;

const server = buildServer({
  dataDir,
  uiDistDir,
  logger: false
});

try {
  const address = await server.listen({ host, port });
  console.log(`Mock Serv API listening at ${address}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
