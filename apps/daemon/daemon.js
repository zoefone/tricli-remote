#!/usr/bin/env node
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  PROVIDERS,
  assertProvider,
  createEvent,
  jsonResponse,
  parseArgs,
  readJsonBody,
  sanitizeFilename,
  textResponse
} from '../../packages/core/protocol.js';
import {
  analyzeSnapshot,
  approvalResponseToKeys,
  eventFromSnapshotAnalysis,
  mergeDetectedApprovals,
  probeProviderAdapters
} from '../../packages/core/adapters.js';
import { CodexAppServerClient } from '../../packages/core/codex-app-server.js';
import { ClaudeStreamJsonClient } from '../../packages/core/claude-stream-json.js';
import { CursorStreamJsonClient } from '../../packages/core/cursor-stream-json.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const args = parseArgs(process.argv.slice(2));
const host = String(args.host || process.env.TRICLI_DAEMON_HOST || '127.0.0.1');
const port = Number(args.port || process.env.TRICLI_DAEMON_PORT || 7317);
const serverUrl = args['server-url'] || process.env.TRICLI_SERVER_URL || '';
const machineId = String(args['machine-id'] || process.env.TRICLI_MACHINE_ID || os.hostname());
const machineName = String(args.name || process.env.TRICLI_MACHINE_NAME || os.hostname());
const token = String(args.token || process.env.TRICLI_TOKEN || '');
const monitorIntervalMs = Number(args['monitor-interval-ms'] || process.env.TRICLI_MONITOR_INTERVAL_MS || 5000);
const stateDir = path.join(os.homedir(), '.tricli-remote', 'daemon');
const stateFile = path.join(stateDir, 'state.json');
const attachmentsDir = path.join(stateDir, 'attachments');
const eventClients = new Set();
let state = { machineId, machineName, events: [], sessions: {}, approvals: [], jobs: [], structuredTurns: [] };
const activeStructuredTurns = new Map();

function log(...items) {
  console.log(new Date().toISOString(), '[daemon]', ...items);
}

async function loadState() {
  await mkdir(attachmentsDir, { recursive: true });
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    state = { machineId, machineName, events: [], sessions: {}, approvals: [], jobs: [], structuredTurns: [] };
  }
  state.machineId = machineId;
  state.machineName = machineName;
  state.events ||= [];
  state.sessions ||= {};
  state.approvals ||= [];
  state.jobs ||= [];
  state.structuredTurns ||= [];
}

async function saveState() {
  await mkdir(stateDir, { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2));
}

function rememberEvent(type, payload = {}) {
  const event = createEvent(type, payload);
  state.events.push(event);
  state.events = state.events.slice(-500);
  for (const client of eventClients) {
    client.write(`event: ${type}\n`);
    client.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  void saveState();
  void pushEventToServer(event);
  return event;
}

async function pushEventToServer(event) {
  if (!serverUrl) return;
  try {
    await fetch(new URL(`/api/machines/${encodeURIComponent(machineId)}/events`, serverUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(event)
    });
  } catch {
    // Best effort: local state remains authoritative if server is unavailable.
  }
}

function run(command, cmdArgs, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, cmdArgs, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      timeout: options.timeout || 30_000,
      maxBuffer: options.maxBuffer || 12 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runAiWork(cmdArgs, options = {}) {
  const result = await run('ai-work', cmdArgs, options);
  return result.stdout.trim();
}

async function providerStatus(provider) {
  try {
    const output = await runAiWork(['status', provider], { timeout: 5_000 });
    return { running: true, output };
  } catch (error) {
    return { running: false, output: String(error.stderr || error.message || '') };
  }
}

async function listSessions() {
  let tmux = [];
  try {
    tmux = JSON.parse(await runAiWork(['list-json'], { timeout: 5_000 }));
  } catch {
    tmux = [];
  }
  const byName = new Map(tmux.map((session) => [session.name, session]));
  const providers = [];
  for (const provider of PROVIDERS) {
    const status = await providerStatus(provider.id);
    providers.push({
      ...provider,
      running: status.running,
      status: status.output,
      tmux: byName.get(provider.tmuxSession) || null,
      lastKnown: state.sessions[provider.id] || null,
      pendingApprovals: (state.approvals || []).filter((item) => item.provider === provider.id && item.status === 'pending').length
    });
  }
  return { machineId, machineName, providers, tmux, updatedAt: new Date().toISOString() };
}

async function startSession(body = {}) {
  const provider = assertProvider(body.provider || 'codex');
  const cwd = body.cwd || process.cwd();
  const extraArgs = Array.isArray(body.args) ? body.args.map(String) : [];
  const requestedAdapter = body.adapter || body.mode || 'work-command';
  const output = await runAiWork(['ensure', provider, '--cwd', cwd, ...extraArgs], { timeout: 20_000 });
  state.sessions[provider] = {
    provider,
    cwd,
    args: extraArgs,
    requestedAdapter,
    activeAdapter: 'work-command',
    adapterFallbackReason: requestedAdapter === 'work-command' ? null : 'structured adapter is probed/readiness-only in this build; persistent tmux fallback owns execution',
    startedAt: state.sessions[provider]?.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    command: output
  };
  rememberEvent('session-started', { provider, cwd, output, requestedAdapter, activeAdapter: 'work-command' });
  return { ok: true, provider, output, session: state.sessions[provider] };
}

async function captureSession(provider, lines = 240, options = {}) {
  assertProvider(provider);
  const output = await runAiWork(['capture', provider, String(lines)], { timeout: 8_000, maxBuffer: 16 * 1024 * 1024 });
  const analysis = analyzeSnapshot(provider, output);
  const previous = state.sessions[provider]?.lastAnalysis || null;
  const previousApprovalCount = (state.approvals || []).filter((item) => item.provider === provider && item.status === 'pending').length;
  state.approvals = mergeDetectedApprovals(state.approvals, analysis.approvals, { machineId, sessionProvider: provider });
  const nextApprovalCount = (state.approvals || []).filter((item) => item.provider === provider && item.status === 'pending').length;
  const statusChanged = previous?.status !== analysis.status;
  const approvalsChanged = previousApprovalCount !== nextApprovalCount;
  const markerChanged = JSON.stringify(previous?.structuredMarkers || {}) !== JSON.stringify(analysis.structuredMarkers || {});
  state.sessions[provider] = {
    ...(state.sessions[provider] || { provider }),
    provider,
    lastSnapshotAt: new Date().toISOString(),
    lastAnalysis: analysis,
    updatedAt: new Date().toISOString()
  };
  if (options.forceEvent || statusChanged || approvalsChanged || markerChanged) {
    const event = eventFromSnapshotAnalysis(analysis);
    event.reason = options.reason || 'snapshot';
    state.events.push(event);
    state.events = state.events.slice(-500);
    for (const client of eventClients) {
      client.write(`event: ${event.type}\n`);
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    void pushEventToServer(event);
    if (approvalsChanged && nextApprovalCount > previousApprovalCount) {
      rememberEvent('approval-detected', { provider, pendingApprovals: nextApprovalCount });
    }
  }
  await saveState();
  return { provider, lines, output, analysis, approvals: state.approvals.filter((item) => item.provider === provider && item.status === 'pending'), capturedAt: new Date().toISOString() };
}

async function sendInput(provider, body = {}) {
  assertProvider(provider);
  const text = String(body.text || body.input || '');
  if (!text) {
    const error = new Error('Missing text');
    error.statusCode = 400;
    throw error;
  }
  const output = await runAiWork(['send', provider, text], { timeout: 8_000 });
  rememberEvent('input-sent', { provider, textPreview: text.slice(0, 200) });
  return { ok: true, provider, output };
}

async function sendKeys(provider, body = {}) {
  assertProvider(provider);
  const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
  if (keys.length === 0) {
    const error = new Error('Missing keys');
    error.statusCode = 400;
    throw error;
  }
  const output = await runAiWork(['keys', provider, ...keys], { timeout: 8_000 });
  rememberEvent('keys-sent', { provider, keys });
  return { ok: true, provider, output };
}

async function stopSession(provider) {
  assertProvider(provider);
  try {
    await runAiWork(['kill', provider], { timeout: 8_000 });
  } catch (error) {
    if (!String(error.stderr || error.message).includes('no server running')) throw error;
  }
  rememberEvent('session-stopped', { provider });
  return { ok: true, provider };
}




function publicStructuredTurn(turn) {
  return {
    id: turn.id,
    provider: turn.provider,
    adapter: turn.adapter,
    status: turn.status,
    cwd: turn.cwd,
    promptPreview: turn.promptPreview,
    threadId: turn.threadId || null,
    turnId: turn.turnId || null,
    createdAt: turn.createdAt,
    startedAt: turn.startedAt || null,
    completedAt: turn.completedAt || null,
    eventCount: (turn.events || []).length,
    requestCount: (turn.requests || []).length,
    textBytes: Buffer.byteLength(turn.summary?.text || ''),
    commandOutputBytes: Buffer.byteLength(turn.summary?.commandOutput || ''),
    error: turn.error || null
  };
}

function listStructuredTurns(provider = null) {
  const turns = state.structuredTurns || [];
  return (provider ? turns.filter((turn) => turn.provider === provider) : turns).map(publicStructuredTurn).reverse();
}

function getStructuredTurn(id) {
  const turn = (state.structuredTurns || []).find((item) => item.id === id);
  if (!turn) {
    const error = new Error(`Unknown structured turn ${id}`);
    error.statusCode = 404;
    throw error;
  }
  return turn;
}

async function startCodexStructuredTurn(body = {}) {
  const prompt = String(body.prompt || body.text || '').trim();
  if (!prompt) {
    const error = new Error('Missing prompt');
    error.statusCode = 400;
    throw error;
  }
  const turn = {
    id: `str_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    provider: 'codex',
    adapter: 'codex-app-server',
    status: 'starting',
    cwd: body.cwd || process.cwd(),
    promptPreview: prompt.slice(0, 240),
    threadId: null,
    turnId: null,
    events: [],
    requests: [],
    summary: { text: '', commandOutput: '', reasoning: '', items: [] },
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null
  };
  state.structuredTurns.push(turn);
  state.structuredTurns = state.structuredTurns.slice(-200);
  await saveState();
  rememberEvent('structured-turn-started', { provider: 'codex', adapter: turn.adapter, structuredTurnId: turn.id, cwd: turn.cwd });

  const client = new CodexAppServerClient({
    cwd: turn.cwd,
    autoApprove: Boolean(body.autoApprove),
    timeoutMs: Number(body.timeoutMs || 120_000),
    model: body.model || null,
    sandbox: body.sandbox || null,
    approvalPolicy: body.approvalPolicy || null
  });
  activeStructuredTurns.set(turn.id, client);

  client.on('event', (event) => {
    turn.events.push(event);
    turn.events = turn.events.slice(-1000);
    if (event.threadId) turn.threadId = event.threadId;
    if (event.turnId) turn.turnId = event.turnId;
    if (event.type === 'codex-agent-delta' || event.type === 'codex-plan-delta') turn.summary.text += event.delta || '';
    if (event.type === 'codex-command-output-delta') turn.summary.commandOutput += event.delta || '';
    if (event.type === 'codex-reasoning-delta') turn.summary.reasoning += event.delta || '';
    if (event.item) turn.summary.items.push(event.item);
    turn.updatedAt = new Date().toISOString();
    void pushEventToServer({ type: 'structured-event', structuredTurnId: turn.id, ...event });
  });
  client.on('server-request', (request) => {
    turn.requests.push({ id: request.id, method: request.method, params: request.params, createdAt: new Date().toISOString() });
    turn.requests = turn.requests.slice(-200);
    void pushEventToServer({ type: 'structured-server-request', structuredTurnId: turn.id, provider: 'codex', method: request.method, params: request.params });
  });
  client.on('stderr', (text) => {
    turn.stderr = `${turn.stderr || ''}${text}`.slice(-256 * 1024);
  });

  (async () => {
    try {
      turn.status = 'running';
      turn.startedAt = new Date().toISOString();
      await saveState();
      const result = await client.runTurn({ prompt, cwd: turn.cwd, images: body.images || [], timeoutMs: body.timeoutMs, autoApprove: body.autoApprove, model: body.model });
      turn.threadId = result.threadId;
      turn.turnId = result.turnId;
      turn.summary = result.summary;
      turn.requests = result.requests;
      turn.status = result.completed?.status === 'failed' ? 'failed' : 'completed';
      turn.completedAt = new Date().toISOString();
      rememberEvent('structured-turn-completed', { provider: 'codex', adapter: turn.adapter, structuredTurnId: turn.id, status: turn.status, threadId: turn.threadId, turnId: turn.turnId });
    } catch (error) {
      turn.status = 'failed';
      turn.error = error.message;
      turn.completedAt = new Date().toISOString();
      rememberEvent('structured-turn-failed', { provider: 'codex', adapter: turn.adapter, structuredTurnId: turn.id, error: error.message });
    } finally {
      activeStructuredTurns.delete(turn.id);
      await client.dispose();
      await saveState();
    }
  })();

  return { ok: true, turn: publicStructuredTurn(turn) };
}


async function startClaudeStructuredTurn(body = {}) {
  const prompt = String(body.prompt || body.text || '').trim();
  if (!prompt) {
    const error = new Error('Missing prompt');
    error.statusCode = 400;
    throw error;
  }
  const turn = {
    id: `str_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    provider: 'claude',
    adapter: 'claude-stream-json',
    status: 'starting',
    cwd: body.cwd || process.cwd(),
    promptPreview: prompt.slice(0, 240),
    threadId: null,
    turnId: null,
    events: [],
    requests: [],
    summary: { text: '', reasoning: '', result: '', tools: [] },
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null
  };
  state.structuredTurns.push(turn);
  state.structuredTurns = state.structuredTurns.slice(-200);
  await saveState();
  rememberEvent('structured-turn-started', { provider: 'claude', adapter: turn.adapter, structuredTurnId: turn.id, cwd: turn.cwd });

  const client = new ClaudeStreamJsonClient({
    cwd: turn.cwd,
    timeoutMs: Number(body.timeoutMs || 120_000),
    model: body.model || null,
    permissionMode: body.permissionMode || null,
    extraArgs: Array.isArray(body.args) ? body.args : []
  });
  activeStructuredTurns.set(turn.id, client);
  client.on('event', (event) => {
    turn.events.push(event);
    turn.events = turn.events.slice(-1000);
    if (event.sessionId) turn.threadId = event.sessionId;
    if (event.type === 'claude-assistant' || event.type === 'claude-tool-use') turn.summary.text += event.text || '';
    if (event.type === 'claude-thinking') turn.summary.reasoning += event.text || '';
    if (event.type === 'claude-result') turn.summary.result += event.result || '';
    if (event.toolUses?.length) turn.summary.tools.push(...event.toolUses);
    turn.updatedAt = new Date().toISOString();
    void pushEventToServer({ type: 'structured-event', structuredTurnId: turn.id, ...event });
  });
  client.on('stderr', (text) => {
    turn.stderr = `${turn.stderr || ''}${text}`.slice(-256 * 1024);
  });
  (async () => {
    try {
      turn.status = 'running';
      turn.startedAt = new Date().toISOString();
      await saveState();
      const result = await client.run({ prompt, cwd: turn.cwd, timeoutMs: body.timeoutMs });
      turn.summary = result.summary;
      turn.events = result.events;
      turn.stderr = result.stderr;
      turn.status = result.status;
      turn.completedAt = new Date().toISOString();
      rememberEvent('structured-turn-completed', { provider: 'claude', adapter: turn.adapter, structuredTurnId: turn.id, status: turn.status });
    } catch (error) {
      turn.status = 'failed';
      turn.error = error.message;
      turn.completedAt = new Date().toISOString();
      rememberEvent('structured-turn-failed', { provider: 'claude', adapter: turn.adapter, structuredTurnId: turn.id, error: error.message });
    } finally {
      activeStructuredTurns.delete(turn.id);
      await client.dispose();
      await saveState();
    }
  })();
  return { ok: true, turn: publicStructuredTurn(turn) };
}


async function startCursorStructuredTurn(body = {}) {
  const prompt = String(body.prompt || body.text || '').trim();
  if (!prompt) {
    const error = new Error('Missing prompt');
    error.statusCode = 400;
    throw error;
  }
  const turn = {
    id: `str_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    provider: 'cursor',
    adapter: 'cursor-stream-json',
    status: 'starting',
    cwd: body.cwd || process.cwd(),
    promptPreview: prompt.slice(0, 240),
    threadId: body.resume || null,
    turnId: null,
    events: [],
    requests: [],
    summary: { text: '', reasoning: '', result: '', tools: [], sessionId: body.resume || null },
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null
  };
  state.structuredTurns.push(turn);
  state.structuredTurns = state.structuredTurns.slice(-200);
  await saveState();
  rememberEvent('structured-turn-started', { provider: 'cursor', adapter: turn.adapter, structuredTurnId: turn.id, cwd: turn.cwd });

  const client = new CursorStreamJsonClient({
    cwd: turn.cwd,
    timeoutMs: Number(body.timeoutMs || 120_000),
    model: body.model || null,
    mode: body.mode || null,
    resume: body.resume || null,
    force: Boolean(body.force),
    extraArgs: Array.isArray(body.args) ? body.args : []
  });
  activeStructuredTurns.set(turn.id, client);
  client.on('event', (event) => {
    turn.events.push(event);
    turn.events = turn.events.slice(-1000);
    if (event.sessionId) {
      turn.threadId = event.sessionId;
      turn.summary.sessionId = event.sessionId;
    }
    if (event.type === 'cursor-assistant' || event.type === 'cursor-tool-use') turn.summary.text += event.text || '';
    if (event.type === 'cursor-thinking') turn.summary.reasoning += event.text || '';
    if (event.type === 'cursor-result') turn.summary.result += event.result || '';
    if (event.toolUses?.length) turn.summary.tools.push(...event.toolUses);
    turn.updatedAt = new Date().toISOString();
    void pushEventToServer({ type: 'structured-event', structuredTurnId: turn.id, ...event });
  });
  client.on('stderr', (text) => {
    turn.stderr = `${turn.stderr || ''}${text}`.slice(-256 * 1024);
  });
  (async () => {
    try {
      turn.status = 'running';
      turn.startedAt = new Date().toISOString();
      await saveState();
      const result = await client.run({ prompt, cwd: turn.cwd, timeoutMs: body.timeoutMs });
      turn.summary = result.summary;
      turn.events = result.events;
      turn.stderr = result.stderr;
      if (result.summary?.sessionId) turn.threadId = result.summary.sessionId;
      turn.status = result.status;
      turn.completedAt = new Date().toISOString();
      rememberEvent('structured-turn-completed', { provider: 'cursor', adapter: turn.adapter, structuredTurnId: turn.id, status: turn.status, sessionId: turn.threadId });
    } catch (error) {
      turn.status = 'failed';
      turn.error = error.message;
      turn.completedAt = new Date().toISOString();
      rememberEvent('structured-turn-failed', { provider: 'cursor', adapter: turn.adapter, structuredTurnId: turn.id, error: error.message });
    } finally {
      activeStructuredTurns.delete(turn.id);
      await client.dispose();
      await saveState();
    }
  })();
  return { ok: true, turn: publicStructuredTurn(turn) };
}

async function killStructuredTurn(id) {
  const turn = getStructuredTurn(id);
  const client = activeStructuredTurns.get(id);
  if (!client) return { ok: true, turn: publicStructuredTurn(turn), alreadyStopped: true };
  await client.dispose();
  turn.status = 'cancelled';
  turn.completedAt = new Date().toISOString();
  activeStructuredTurns.delete(id);
  rememberEvent('structured-turn-cancelled', { provider: turn.provider, structuredTurnId: id });
  await saveState();
  return { ok: true, turn: publicStructuredTurn(turn) };
}

function providerBinary(provider) {
  assertProvider(provider);
  if (provider === 'codex') return 'codex';
  if (provider === 'claude') return 'claude';
  if (provider === 'cursor') return 'cursor-agent';
  return provider;
}

function publicJob(job) {
  return {
    id: job.id,
    provider: job.provider,
    command: job.command,
    args: job.args,
    cwd: job.cwd,
    status: job.status,
    pid: job.pid || null,
    exitCode: job.exitCode ?? null,
    signal: job.signal ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt || null,
    stdoutBytes: Buffer.byteLength(job.stdout || ''),
    stderrBytes: Buffer.byteLength(job.stderr || '')
  };
}

function appendJobOutput(job, stream, chunk) {
  const text = chunk.toString('utf8');
  const key = stream === 'stderr' ? 'stderr' : 'stdout';
  job[key] = `${job[key] || ''}${text}`.slice(-1024 * 1024);
  job.updatedAt = new Date().toISOString();
}

async function startCliJob(body = {}) {
  const provider = assertProvider(body.provider || 'codex');
  const args = Array.isArray(body.args) ? body.args.map(String) : [];
  const cwd = body.cwd || process.cwd();
  const command = providerBinary(provider);
  const job = {
    id: `job_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    provider,
    command,
    args,
    cwd,
    status: 'starting',
    stdout: '',
    stderr: '',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null
  };
  state.jobs.push(job);
  state.jobs = state.jobs.slice(-200);
  await saveState();
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  job.pid = child.pid;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  rememberEvent('cli-job-started', { provider, jobId: job.id, command, args, cwd, pid: child.pid });
  child.stdout.on('data', (chunk) => appendJobOutput(job, 'stdout', chunk));
  child.stderr.on('data', (chunk) => appendJobOutput(job, 'stderr', chunk));
  child.on('error', (error) => {
    job.status = 'failed';
    job.stderr = `${job.stderr || ''}
${error.message}`;
    job.completedAt = new Date().toISOString();
    rememberEvent('cli-job-failed', { provider, jobId: job.id, error: error.message });
    void saveState();
  });
  child.on('close', (code, signal) => {
    job.status = code === 0 ? 'completed' : 'failed';
    job.exitCode = code;
    job.signal = signal;
    job.completedAt = new Date().toISOString();
    rememberEvent('cli-job-completed', { provider, jobId: job.id, status: job.status, exitCode: code, signal });
    void saveState();
  });
  await saveState();
  return { ok: true, job: publicJob(job) };
}

function listJobs(provider = null) {
  const jobs = state.jobs || [];
  return (provider ? jobs.filter((job) => job.provider === provider) : jobs).map(publicJob).reverse();
}

function getJob(id) {
  const job = (state.jobs || []).find((item) => item.id === id);
  if (!job) {
    const error = new Error(`Unknown job ${id}`);
    error.statusCode = 404;
    throw error;
  }
  return job;
}

async function killJob(id) {
  const job = getJob(id);
  if (job.status !== 'running' || !job.pid) return { ok: true, job: publicJob(job), alreadyStopped: true };
  try {
    process.kill(job.pid, 'SIGTERM');
    job.status = 'terminating';
    job.updatedAt = new Date().toISOString();
    rememberEvent('cli-job-kill-requested', { provider: job.provider, jobId: job.id, pid: job.pid });
    await saveState();
  } catch (error) {
    job.stderr = `${job.stderr || ''}
kill failed: ${error.message}`;
  }
  return { ok: true, job: publicJob(job) };
}

function listApprovals(provider = null) {
  const approvals = state.approvals || [];
  return provider ? approvals.filter((item) => item.provider === provider) : approvals;
}

async function respondApproval(id, body = {}) {
  const approval = (state.approvals || []).find((item) => item.id === id);
  if (!approval) {
    const error = new Error(`Unknown approval ${id}`);
    error.statusCode = 404;
    throw error;
  }
  if (approval.status !== 'pending') {
    return { ok: true, approval, alreadyResolved: true };
  }
  const keys = approvalResponseToKeys(body);
  if (body.send !== false) {
    await runAiWork(['keys', approval.provider, ...keys], { timeout: 8_000 });
  }
  approval.status = body.status || 'responded';
  approval.response = { ...body, keys };
  approval.respondedAt = new Date().toISOString();
  rememberEvent('approval-responded', { provider: approval.provider, approvalId: id, keys });
  await saveState();
  return { ok: true, approval };
}

async function saveUpload(body = {}) {
  const provider = body.provider ? assertProvider(body.provider) : 'codex';
  const filename = sanitizeFilename(body.filename || body.name || 'upload.bin');
  const contentBase64 = String(body.contentBase64 || body.base64 || '');
  if (!contentBase64) {
    const error = new Error('Missing contentBase64');
    error.statusCode = 400;
    throw error;
  }
  const sessionDir = path.join(attachmentsDir, provider, new Date().toISOString().slice(0, 10));
  await mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `${Date.now()}-${filename}`);
  await writeFile(filePath, Buffer.from(contentBase64, 'base64'));
  rememberEvent('attachment-uploaded', { provider, filename, filePath, bytes: Buffer.byteLength(contentBase64, 'base64') });
  return { ok: true, provider, filename, path: filePath };
}

function checkToken(req, url = null) {
  if (!token) return true;
  const queryToken = url?.searchParams?.get('token') || '';
  if (queryToken && queryToken === token) return true;
  const header = req.headers.authorization || req.headers['x-tricli-token'] || '';
  const presented = String(header).replace(/^Bearer\s+/i, '');
  return presented === token;
}

async function handleApi(method, pathname, query, body = {}) {
  if (method === 'GET' && pathname === '/api/providers') return { providers: PROVIDERS };
  if (method === 'GET' && pathname === '/api/adapters') return { providers: await probeProviderAdapters() };
  if (method === 'GET' && pathname === '/api/events/history') return { events: state.events || [] };
  if (method === 'GET' && pathname === '/api/structured/codex/turns') return { turns: listStructuredTurns('codex') };
  if (method === 'GET' && pathname === '/api/structured/claude/turns') return { turns: listStructuredTurns('claude') };
  if (method === 'GET' && pathname === '/api/structured/cursor/turns') return { turns: listStructuredTurns('cursor') };
  if (method === 'POST' && pathname === '/api/structured/codex/turn') return startCodexStructuredTurn(body);
  if (method === 'POST' && pathname === '/api/structured/claude/turn') return startClaudeStructuredTurn(body);
  if (method === 'POST' && pathname === '/api/structured/cursor/turn') return startCursorStructuredTurn(body);
  const structuredMatch = pathname.match(/^\/api\/structured\/(codex|claude|cursor)\/turns\/([^/]+)(?:\/(kill))?$/);
  if (structuredMatch && method === 'GET' && !structuredMatch[3]) {
    const turn = getStructuredTurn(decodeURIComponent(structuredMatch[2]));
    return { turn: publicStructuredTurn(turn), events: turn.events || [], requests: turn.requests || [], summary: turn.summary || {}, stderr: turn.stderr || '' };
  }
  if (structuredMatch && method === 'POST' && structuredMatch[3] === 'kill') return killStructuredTurn(decodeURIComponent(structuredMatch[2]));
  if (method === 'GET' && pathname === '/api/jobs') return { jobs: listJobs(query.get('provider')) };
  if (method === 'POST' && pathname === '/api/jobs') return startCliJob(body);
  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(kill))?$/);
  if (jobMatch && method === 'GET' && !jobMatch[2]) {
    const job = getJob(decodeURIComponent(jobMatch[1]));
    return { job: publicJob(job), stdout: job.stdout || '', stderr: job.stderr || '' };
  }
  if (jobMatch && method === 'POST' && jobMatch[2] === 'kill') return killJob(decodeURIComponent(jobMatch[1]));
  if (method === 'GET' && pathname === '/api/approvals') return { approvals: listApprovals(query.get('provider')) };
  const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/respond$/);
  if (method === 'POST' && approvalMatch) return respondApproval(decodeURIComponent(approvalMatch[1]), body);
  if (method === 'GET' && pathname === '/api/sessions') return listSessions();
  if (method === 'POST' && pathname === '/api/sessions') return startSession(body);
  if (method === 'POST' && pathname === '/api/upload') return saveUpload(body);
  const match = pathname.match(/^\/api\/sessions\/([^/]+)\/(snapshot|input|keys|stop)$/);
  if (match) {
    const provider = match[1];
    const action = match[2];
    if (method === 'GET' && action === 'snapshot') return captureSession(provider, Number(query.get('lines') || 240));
    if (method === 'POST' && action === 'input') return sendInput(provider, body);
    if (method === 'POST' && action === 'keys') return sendKeys(provider, body);
    if (method === 'POST' && action === 'stop') return stopSession(provider);
  }
  const error = new Error(`Not found: ${method} ${pathname}`);
  error.statusCode = 404;
  throw error;
}

async function handleRequest(req, res) {
  try {
    if (req.method === 'OPTIONS') return jsonResponse(res, 204, {});
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    if (!checkToken(req, url)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    if (req.method === 'GET' && pathname === '/healthz') {
      return jsonResponse(res, 200, { ok: true, machineId, machineName, time: new Date().toISOString() });
    }
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*'
      });
      eventClients.add(res);
      res.write(`event: hello\ndata: ${JSON.stringify({ machineId, machineName })}\n\n`);
      const timer = setInterval(async () => {
        try {
          const sessions = await listSessions();
          res.write(`event: sessions\ndata: ${JSON.stringify(sessions)}\n\n`);
        } catch (error) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
        }
      }, 2500);
      req.on('close', () => {
        clearInterval(timer);
        eventClients.delete(res);
      });
      return;
    }
    if (pathname.startsWith('/api/')) {
      const body = req.method === 'GET' ? {} : await readJsonBody(req);
      const result = await handleApi(req.method, pathname, url.searchParams, body);
      return jsonResponse(res, 200, result);
    }
    if (pathname === '/' || pathname === '/index.html') {
      const readme = path.join(__dirname, '..', 'web', 'index.html');
      return createReadStream(readme).pipe(res);
    }
    return textResponse(res, 404, 'Not found');
  } catch (error) {
    return jsonResponse(res, error.statusCode || 500, {
      error: error.message,
      stderr: error.stderr,
      stdout: error.stdout
    });
  }
}


async function monitorLoop() {
  if (!monitorIntervalMs || monitorIntervalMs < 1000) return;
  log('background monitor enabled', `${monitorIntervalMs}ms`);
  while (true) {
    try {
      for (const provider of PROVIDERS) {
        const status = await providerStatus(provider.id);
        if (!status.running) continue;
        await captureSession(provider.id, 220, { reason: 'background-monitor' });
      }
    } catch (error) {
      log('monitor loop:', error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, monitorIntervalMs));
  }
}

async function registerWithServer() {
  if (!serverUrl) return;
  const localUrl = `http://${host === '0.0.0.0' ? os.hostname() : host}:${port}`;
  try {
    await fetch(new URL('/api/machines/register', serverUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ machineId, name: machineName, localUrl, capabilities: { relayPolling: true, providers: PROVIDERS.map((p) => p.id) } })
    });
  } catch (error) {
    log('register failed:', error.message);
  }
}

async function relayLoop() {
  if (!serverUrl) return;
  log('relay polling enabled', serverUrl, machineId);
  while (true) {
    try {
      await registerWithServer();
      const pollUrl = new URL(`/api/relay/${encodeURIComponent(machineId)}/poll`, serverUrl);
      const response = await fetch(pollUrl, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (response.status === 204) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      if (!response.ok) throw new Error(`poll ${response.status}`);
      const command = await response.json();
      let result;
      try {
        result = await handleApi(command.method || 'GET', command.path, new URLSearchParams(command.query || ''), command.body || {});
      } catch (error) {
        result = { error: error.message, stderr: error.stderr, stdout: error.stdout, statusCode: error.statusCode || 500 };
      }
      await fetch(new URL(`/api/relay/${encodeURIComponent(machineId)}/result/${encodeURIComponent(command.id)}`, serverUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(result)
      });
    } catch (error) {
      log('relay loop:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

await loadState();
const server = http.createServer(handleRequest);
server.listen(port, host, () => {
  log(`listening http://${host}:${port}`, `machineId=${machineId}`);
  rememberEvent('daemon-started', { host, port, serverUrl: serverUrl || null, monitorIntervalMs });
  void monitorLoop();
  void relayLoop();
});
