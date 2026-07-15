import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findFreePort(start, callback) {
  const tryPort = (port) => {
    const srv = createServer();
    srv.once('error', () => tryPort(port + 1));
    srv.once('listening', () => {
      srv.close(() => callback(port));
    });
    srv.listen(port, '127.0.0.1');
  };
  tryPort(start);
}

const preferredApiPort = Number(process.env.MOCK_SERV_PORT || 3001);

findFreePort(preferredApiPort, (apiPort) => {
  process.env.MOCK_SERV_PORT = String(apiPort);

  const api = spawn('npx', ['tsx', 'watch', 'apps/server/src/index.ts'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, MOCK_SERV_PORT: String(apiPort) }
  });

  const vite = spawn('npx', ['vite', '--config', 'apps/desktop/vite.config.ts'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, MOCK_SERV_PORT: String(apiPort) }
  });

  function cleanup() {
    api.kill();
    vite.kill();
    process.exit();
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  api.on('exit', () => { vite.kill(); process.exit(); });
  vite.on('exit', () => { api.kill(); process.exit(); });
});
