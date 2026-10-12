#!/usr/bin/env node
/**
 * Sobe API, worker e web em um unico terminal.
 *
 * Por que um script e nao `concurrently`: precisamos de ordem (migrations
 * antes da API), de prefixo colorido por processo e, principalmente, de
 * desligamento em grupo -- com `concurrently` e comum um filho sobreviver ao
 * Ctrl+C no Windows e segurar a porta 4000, obrigando a matar na mao.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const COLORS = { api: '\u001B[36m', worker: '\u001B[35m', web: '\u001B[32m', setup: '\u001B[33m' };
const RESET = '\u001B[0m';
const isWindows = process.platform === 'win32';

const children = new Map();
let shuttingDown = false;

function prefix(name, line) {
  const color = COLORS[name] ?? '';
  return `${color}${name.padEnd(6)}${RESET} ${line}`;
}

function pipe(name, stream, target) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) target.write(`${prefix(name, line)}\n`);
    }
  });
}

function start(name, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    // `shell: true` no Windows permite resolver os .cmd de node_modules/.bin.
    shell: isWindows,
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  children.set(name, child);
  pipe(name, child.stdout, process.stdout);
  pipe(name, child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;
    process.stdout.write(prefix(name, `encerrou (code=${code ?? 'null'} signal=${signal ?? 'null'})\n`));
    // Se um processo essencial cai, nao deixamos os outros rodando pela metade.
    shutdown(1);
  });

  return child;
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(prefix('setup', 'encerrando...\n'));

  for (const [name, child] of children) {
    try {
      if (isWindows) {
        // SIGTERM nao propaga para a arvore no Windows.
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      process.stdout.write(prefix('setup', `nao consegui encerrar ${name}\n`));
    }
  }

  setTimeout(() => process.exit(exitCode), 1500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, shell: isWindows, stdio: ['ignore', 'pipe', 'pipe'] });
    pipe('setup', child.stdout, process.stdout);
    pipe('setup', child.stderr, process.stderr);
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} saiu com codigo ${code}`)),
    );
  });
}

// Migrations antes de qualquer processo: a API subiria e falharia no primeiro
// acesso ao banco, e o erro ficaria enterrado no meio do log dos tres.
process.stdout.write(prefix('setup', 'aplicando migrations...\n'));
try {
  await run('npm', ['run', 'db:migrate']);
} catch (error) {
  process.stderr.write(prefix('setup', `falha nas migrations: ${error.message}\n`));
  process.exit(1);
}

start('api', 'npm', ['run', 'dev', '-w', '@castwave/api']);
start('worker', 'npm', ['run', 'dev', '-w', '@castwave/worker']);
start('web', 'npm', ['run', 'dev', '-w', '@castwave/web']);

process.stdout.write(
  prefix('setup', 'painel em http://localhost:3000 · API em http://127.0.0.1:4000\n'),
);
