import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const llmModelDir = resolve(rootDir, 'llm-model');

function findFreePort(start) {
  return new Promise((resolvePort) => {
    const tryPort = (port) => {
      const srv = createServer();
      srv.once('error', () => tryPort(port + 1));
      srv.once('listening', () => {
        srv.close(() => resolvePort(port));
      });
      srv.listen(port, '127.0.0.1');
    };
    tryPort(start);
  });
}

function findCommand(command) {
  return new Promise((resolveCommand) => {
    const child = spawn('sh', ['-lc', `command -v ${command}`], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('exit', (code) => {
      resolveCommand(code === 0 ? output.trim() : null);
    });
  });
}

function findModelFile() {
  if (process.env.MOCK_SERV_LLM_MODEL) return resolve(rootDir, process.env.MOCK_SERV_LLM_MODEL);
  if (!existsSync(llmModelDir)) return null;
  const models = readdirSync(llmModelDir)
    .filter((file) => file.toLowerCase().endsWith('.gguf'))
    .sort();
  return models[0] ? resolve(llmModelDir, models[0]) : null;
}

async function maybeStartLlamaServer() {
  if (process.env.MOCK_SERV_LLM_DISABLED === '1') return null;
  const modelFile = findModelFile();
  if (!modelFile || !existsSync(modelFile)) {
    console.log('LLM model not found in llm-model/. Skipping llama server.');
    return null;
  }
  const llamaServer = process.env.LLAMA_SERVER_BIN || await findCommand('llama-server');
  if (!llamaServer) {
    console.log('llama-server binary not found. Install llama.cpp or set LLAMA_SERVER_BIN. Skipping llama server.');
    return null;
  }
  const port = Number(process.env.MOCK_SERV_LLM_PORT || await findFreePort(8080));
  const args = [
    '--model', modelFile,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--ctx-size', process.env.MOCK_SERV_LLM_CTX || '4096'
  ];
  console.log(`Starting llama server on http://127.0.0.1:${port} with ${modelFile}`);
  const child = spawn(llamaServer, args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env }
  });
  return { child, url: `http://127.0.0.1:${port}` };
}

const preferredApiPort = Number(process.env.MOCK_SERV_PORT || 3001);

const apiPort = await findFreePort(preferredApiPort);
const llm = await maybeStartLlamaServer();
process.env.MOCK_SERV_PORT = String(apiPort);
if (llm) process.env.MOCK_SERV_LLM_BASE_URL = llm.url;

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
  llm?.child.kill();
  process.exit();
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

api.on('exit', () => { vite.kill(); llm?.child.kill(); process.exit(); });
vite.on('exit', () => { api.kill(); llm?.child.kill(); process.exit(); });
llm?.child.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.log(`llama server exited with code ${code}; app will continue without local LLM.`);
  }
});
