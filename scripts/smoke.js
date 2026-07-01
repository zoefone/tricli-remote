#!/usr/bin/env node
import { spawn } from 'node:child_process';

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function start(cmd, args, env) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  child.stdout.on('data', (data) => process.stdout.write(data));
  child.stderr.on('data', (data) => process.stderr.write(data));
  return child;
}

const server = start('node', ['apps/server/server.js', '--host', '127.0.0.1', '--port', '17320']);
let daemon;
try {
  await wait(500);
  daemon = start('node', ['apps/daemon/daemon.js', '--host', '127.0.0.1', '--port', '17317', '--server-url', 'http://127.0.0.1:17320', '--machine-id', 'smoke-machine']);
  await wait(2500);
  let res = await fetch('http://127.0.0.1:17320/api/machines');
  let data = await res.json();
  if (!data.machines.some((machine) => machine.machineId === 'smoke-machine')) throw new Error('machine not registered');
  res = await fetch('http://127.0.0.1:17320/api/machines/smoke-machine/daemon/api/sessions');
  data = await res.json();
  if (!Array.isArray(data.providers)) throw new Error('sessions relay failed');
  res = await fetch('http://127.0.0.1:17320/api/machines/smoke-machine/daemon/api/adapters');
  data = await res.json();
  if (!data.providers?.some((provider) => provider.adapters?.some((adapter) => adapter.kind === 'work-command'))) throw new Error('adapter relay failed');
  res = await fetch('http://127.0.0.1:17320/api/machines/smoke-machine/daemon/api/approvals');
  data = await res.json();
  if (!Array.isArray(data.approvals)) throw new Error('approvals relay failed');
  await wait(500);
  res = await fetch('http://127.0.0.1:17320/api/machines/smoke-machine/events');
  data = await res.json();
  if (!Array.isArray(data.events)) throw new Error('machine events endpoint failed');
  if (!data.events.some((event) => event.type === 'daemon-started')) throw new Error('daemon event was not uploaded to server');
  res = await fetch('http://127.0.0.1:17320/api/notifications/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ smoke: true }) });
  data = await res.json();
  if (!data.ok || !data.notification?.title) throw new Error('notification test failed');
  console.log('SMOKE OK');
} finally {
  server.kill('SIGTERM');
  daemon?.kill('SIGTERM');
}
