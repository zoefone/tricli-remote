#!/usr/bin/env node
import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { jsonResponse, parseArgs, readJsonBody, textResponse } from '../../packages/core/protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const args = parseArgs(process.argv.slice(2));
const host = String(args.host || process.env.TRICLI_SERVER_HOST || '127.0.0.1');
const port = Number(args.port || process.env.TRICLI_SERVER_PORT || 7320);
const token = String(args.token || process.env.TRICLI_TOKEN || '');
const notificationWebhook = String(args['notification-webhook'] || process.env.TRICLI_NOTIFICATION_WEBHOOK || '');
const stateDir = path.join(os.homedir(), '.tricli-remote', 'server');
const stateFile = path.join(stateDir, 'state.json');
const webRoot = path.resolve(__dirname, '..', 'web');
let state = { machines: {}, events: [], pushTokens: [], machineEvents: {}, notifications: [] };
const waitingPolls = new Map();
const queues = new Map();
const pending = new Map();
const sseClients = new Set();

function log(...items) {
  console.log(new Date().toISOString(), '[server]', ...items);
}

async function loadState() {
  await mkdir(stateDir, { recursive: true });
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    state = { machines: {}, events: [], pushTokens: [], machineEvents: {}, notifications: [] };
  }
  state.machines ||= {};
  state.events ||= [];
  state.pushTokens ||= [];
  state.machineEvents ||= {};
  state.notifications ||= [];
}

async function saveState() {
  await mkdir(stateDir, { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2));
}

function checkToken(req, url = null) {
  if (!token) return true;
  const queryToken = url?.searchParams?.get('token') || '';
  if (queryToken && queryToken === token) return true;
  const header = req.headers.authorization || req.headers['x-tricli-token'] || '';
  const presented = String(header).replace(/^Bearer\s+/i, '');
  return presented === token;
}

function emit(type, payload = {}) {
  const event = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, type, createdAt: new Date().toISOString(), ...payload };
  state.events.push(event);
  state.events = state.events.slice(-500);
  for (const client of sseClients) {
    client.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  void saveState();
  return event;
}



async function dispatchNotification(notification) {
  const normalized = {
    id: `ntf_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    ...notification
  };
  state.notifications.push(normalized);
  state.notifications = state.notifications.slice(-500);
  emit('notification-created', normalized);
  if (notificationWebhook) {
    try {
      await fetch(notificationWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(normalized)
      });
      normalized.deliveredAt = new Date().toISOString();
    } catch (error) {
      normalized.deliveryError = error.message;
    }
  }
  void saveState();
  return normalized;
}

function notificationFromMachineEvent(machineId, event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'approval-detected') {
    return {
      machineId,
      severity: 'attention',
      title: 'TriCLI 需要处理审批',
      body: `${event.provider || 'CLI'} 有 ${event.pendingApprovals || 1} 个待审批/选择项`,
      data: event
    };
  }
  if (event.type === 'session-started') {
    return {
      machineId,
      severity: 'running',
      title: 'TriCLI 会话已启动',
      body: `${event.provider || 'CLI'} 正在目标机器继续运行`,
      data: event
    };
  }
  if (event.type === 'session-stopped') {
    return {
      machineId,
      severity: 'info',
      title: 'TriCLI 会话已停止',
      body: `${event.provider || 'CLI'} 已停止`,
      data: event
    };
  }
  if (event.type === 'snapshot-analyzed' && event.status === 'attention') {
    return {
      machineId,
      severity: 'attention',
      title: 'TriCLI 任务需要注意',
      body: `${event.provider || 'CLI'} 输出中出现错误/拒绝/审批提示`,
      data: event
    };
  }
  if (event.type === 'snapshot-analyzed' && event.status === 'ready') {
    return {
      machineId,
      severity: 'ready',
      title: 'TriCLI 任务可能已完成',
      body: `${event.provider || 'CLI'} 输出显示 ready/completed`,
      data: event
    };
  }
  return null;
}

function recordMachineEvent(machineId, event) {
  const normalized = {
    ...event,
    machineId,
    receivedAt: new Date().toISOString()
  };
  const list = state.machineEvents[machineId] || [];
  list.push(normalized);
  state.machineEvents[machineId] = list.slice(-500);
  emit('machine-event', { machineId, event: normalized });
  const notification = notificationFromMachineEvent(machineId, normalized);
  if (notification) void dispatchNotification(notification);
  return normalized;
}

function publicMachines() {
  return Object.values(state.machines).map((machine) => ({
    ...machine,
    queueDepth: (queues.get(machine.machineId) || []).length,
    pendingDepth: [...pending.values()].filter((item) => item.machineId === machine.machineId).length
  }));
}

function registerMachine(body = {}) {
  const machineId = String(body.machineId || '').trim();
  if (!machineId) {
    const error = new Error('Missing machineId');
    error.statusCode = 400;
    throw error;
  }
  const previous = state.machines[machineId] || {};
  const machine = {
    ...previous,
    machineId,
    name: String(body.name || previous.name || machineId),
    localUrl: body.localUrl || previous.localUrl || null,
    directUrl: body.directUrl || previous.directUrl || null,
    capabilities: body.capabilities || previous.capabilities || {},
    online: true,
    lastSeenAt: new Date().toISOString(),
    transport: body.directUrl ? 'direct' : 'relay-poll'
  };
  state.machines[machineId] = machine;
  emit('machine-registered', { machineId, name: machine.name });
  return { ok: true, machine };
}

function resolvePoll(machineId, command) {
  const waiters = waitingPolls.get(machineId) || [];
  const waiter = waiters.shift();
  if (waiter) {
    waiter(command);
    return true;
  }
  return false;
}

function enqueueCommand(machineId, command) {
  if (resolvePoll(machineId, command)) return;
  const queue = queues.get(machineId) || [];
  queue.push(command);
  queues.set(machineId, queue);
}

function waitForResult(command, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(command.id);
      reject(Object.assign(new Error('Timed out waiting for machine relay result'), { statusCode: 504 }));
    }, timeoutMs);
    pending.set(command.id, { machineId: command.machineId, resolve, reject, timeout });
  });
}

async function relayRequest(machineId, method, pathValue, query, body) {
  const machine = state.machines[machineId];
  if (!machine) {
    const error = new Error(`Unknown machine ${machineId}`);
    error.statusCode = 404;
    throw error;
  }

  if (machine.directUrl) {
    const target = new URL(pathValue + (query ? `?${query}` : ''), machine.directUrl);
    const response = await fetch(target, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body || {})
    });
    const text = await response.text();
    try {
      return JSON.parse(text || '{}');
    } catch {
      return { status: response.status, text };
    }
  }

  const command = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    machineId,
    method,
    path: pathValue,
    query: query || '',
    body: body || {},
    createdAt: new Date().toISOString()
  };
  enqueueCommand(machineId, command);
  emit('relay-command-enqueued', { machineId, commandId: command.id, method, path: pathValue });
  return waitForResult(command);
}

async function handleRelayPoll(machineId, req, res) {
  const machine = state.machines[machineId] || { machineId, name: machineId };
  state.machines[machineId] = { ...machine, online: true, lastSeenAt: new Date().toISOString(), transport: 'relay-poll' };
  void saveState();
  const queue = queues.get(machineId) || [];
  if (queue.length > 0) {
    const command = queue.shift();
    return jsonResponse(res, 200, command);
  }
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      const waiters = waitingPolls.get(machineId) || [];
      waitingPolls.set(machineId, waiters.filter((item) => item !== deliver));
      jsonResponse(res, 204, {});
      resolve();
    }, 25_000);
    const deliver = (command) => {
      clearTimeout(timeout);
      jsonResponse(res, 200, command);
      resolve();
    };
    const waiters = waitingPolls.get(machineId) || [];
    waiters.push(deliver);
    waitingPolls.set(machineId, waiters);
    req.on('close', () => {
      clearTimeout(timeout);
      waitingPolls.set(machineId, (waitingPolls.get(machineId) || []).filter((item) => item !== deliver));
      resolve();
    });
  });
}

async function handleRelayResult(machineId, commandId, body) {
  const item = pending.get(commandId);
  if (!item) return { ok: false, reason: 'unknown-command' };
  clearTimeout(item.timeout);
  pending.delete(commandId);
  if (body?.error) {
    item.resolve(body);
  } else {
    item.resolve(body);
  }
  emit('relay-command-completed', { machineId, commandId, ok: !body?.error });
  return { ok: true };
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(webRoot, `.${rel}`);
  if (!filePath.startsWith(webRoot) || !existsSync(filePath)) return false;
  res.writeHead(200, { 'content-type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
  return true;
}

async function handleRequest(req, res) {
  try {
    if (req.method === 'OPTIONS') return jsonResponse(res, 204, {});
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/healthz') {
      return jsonResponse(res, 200, { ok: true, role: 'server', time: new Date().toISOString() });
    }
    if (!pathname.startsWith('/api/') && serveStatic(pathname, res)) return;
    if (!checkToken(req, url)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*'
      });
      sseClients.add(res);
      res.write(`event: hello\ndata: ${JSON.stringify({ machines: publicMachines() })}\n\n`);
      const timer = setInterval(() => {
        res.write(`event: machines\ndata: ${JSON.stringify({ machines: publicMachines(), time: new Date().toISOString() })}\n\n`);
      }, 3000);
      req.on('close', () => {
        clearInterval(timer);
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/notifications') {
      return jsonResponse(res, 200, { notifications: state.notifications || [] });
    }
    if (req.method === 'POST' && pathname === '/api/notifications/test') {
      const notification = await dispatchNotification({
        severity: 'test',
        title: 'TriCLI test notification',
        body: 'Notification pipeline is reachable.',
        data: await readJsonBody(req)
      });
      return jsonResponse(res, 200, { ok: true, notification });
    }
    if (req.method === 'GET' && pathname === '/api/push/tokens') {
      return jsonResponse(res, 200, { tokens: state.pushTokens || [] });
    }
    if (req.method === 'POST' && pathname === '/api/push/register') {
      const body = await readJsonBody(req);
      const value = String(body.token || body.endpoint || '').trim();
      if (!value) return jsonResponse(res, 400, { error: 'Missing token or endpoint' });
      const tokenRecord = { kind: body.kind || 'unknown', token: value, platform: body.platform || 'unknown', createdAt: new Date().toISOString() };
      state.pushTokens = [...(state.pushTokens || []).filter((item) => item.token !== value), tokenRecord];
      emit('push-token-registered', { kind: tokenRecord.kind, platform: tokenRecord.platform });
      return jsonResponse(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/machines') return jsonResponse(res, 200, { machines: publicMachines() });
    const machineEvents = pathname.match(/^\/api\/machines\/([^/]+)\/events$/);
    if (machineEvents && req.method === 'GET') {
      const machineId = decodeURIComponent(machineEvents[1]);
      return jsonResponse(res, 200, { events: state.machineEvents[machineId] || [] });
    }
    if (machineEvents && req.method === 'POST') {
      const machineId = decodeURIComponent(machineEvents[1]);
      const event = recordMachineEvent(machineId, await readJsonBody(req));
      return jsonResponse(res, 200, { ok: true, event });
    }
    if (req.method === 'POST' && pathname === '/api/machines/register') {
      return jsonResponse(res, 200, registerMachine(await readJsonBody(req)));
    }

    const poll = pathname.match(/^\/api\/relay\/([^/]+)\/poll$/);
    if (req.method === 'GET' && poll) return handleRelayPoll(decodeURIComponent(poll[1]), req, res);
    const result = pathname.match(/^\/api\/relay\/([^/]+)\/result\/([^/]+)$/);
    if (req.method === 'POST' && result) {
      const response = await handleRelayResult(decodeURIComponent(result[1]), decodeURIComponent(result[2]), await readJsonBody(req));
      return jsonResponse(res, 200, response);
    }

    const proxy = pathname.match(/^\/api\/machines\/([^/]+)\/daemon(\/.*)$/);
    if (proxy) {
      const machineId = decodeURIComponent(proxy[1]);
      const pathValue = proxy[2] || '/api/sessions';
      const body = req.method === 'GET' ? {} : await readJsonBody(req);
      const response = await relayRequest(machineId, req.method, pathValue, url.searchParams.toString(), body);
      return jsonResponse(res, response?.statusCode || 200, response);
    }

    return textResponse(res, 404, 'Not found');
  } catch (error) {
    return jsonResponse(res, error.statusCode || 500, { error: error.message, stack: process.env.NODE_ENV === 'development' ? error.stack : undefined });
  }
}

await loadState();
const server = http.createServer(handleRequest);
server.listen(port, host, () => {
  log(`listening http://${host}:${port}`);
  emit('server-started', { host, port });
});
