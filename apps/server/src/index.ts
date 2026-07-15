import path from 'node:path';
import { buildServer } from './app.ts';

const host = process.env.MOCK_SERV_HOST ?? '127.0.0.1';
const desiredPort = Number(process.env.MOCK_SERV_PORT || 3001);
const dataDir = process.env.MOCK_SERV_DATA_DIR ? path.resolve(process.cwd(), process.env.MOCK_SERV_DATA_DIR) : undefined;
const uiDistDir = process.env.MOCK_SERV_UI_DIST ? path.resolve(process.cwd(), process.env.MOCK_SERV_UI_DIST) : undefined;

const server = buildServer({
  dataDir,
  uiDistDir,
  logger: false
});

let port = desiredPort;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    const address = await server.listen({ host, port });
    console.log(`Mock Serv API listening at ${address}`);
    port = 0;
    break;
  } catch (error: any) {
    if (error?.code === 'EADDRINUSE') {
      console.log(`Port ${port} in use, trying ${port + 1}...`);
      port++;
    } else {
      console.error(error);
      process.exit(1);
    }
  }
}

if (port !== 0) {
  console.error('Could not find an available port after 20 attempts.');
  process.exit(1);
}
