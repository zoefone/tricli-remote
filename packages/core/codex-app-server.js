import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export function mapCodexAppServerNotification(message) {
  if (!message || !message.method) return null;
  const params = message.params || {};
  const base = {
    provider: 'codex',
    adapter: 'codex-app-server',
    method: message.method,
    params
  };
  switch (message.method) {
    case 'thread/started':
      return { ...base, type: 'codex-thread-started', threadId: params.thread?.id || null };
    case 'turn/started':
      return { ...base, type: 'codex-turn-started', threadId: params.threadId || null, turnId: params.turn?.id || null, status: params.turn?.status || null };
    case 'turn/completed':
      return { ...base, type: 'codex-turn-completed', threadId: params.threadId || null, turnId: params.turn?.id || null, status: params.turn?.status || null, error: params.turn?.error || null };
    case 'item/started':
      return { ...base, type: 'codex-item-started', threadId: params.threadId || null, turnId: params.turnId || null, itemId: params.item?.id || null, itemType: params.item?.type || null, item: params.item || null };
    case 'item/completed':
      return { ...base, type: 'codex-item-completed', threadId: params.threadId || null, turnId: params.turnId || null, itemId: params.item?.id || null, itemType: params.item?.type || null, item: params.item || null };
    case 'item/agentMessage/delta':
      return { ...base, type: 'codex-agent-delta', threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, delta: params.delta || '' };
    case 'item/plan/delta':
      return { ...base, type: 'codex-plan-delta', threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, delta: params.delta || '' };
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
      return { ...base, type: 'codex-reasoning-delta', threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, delta: params.delta || params.text || '' };
    case 'item/commandExecution/outputDelta':
      return { ...base, type: 'codex-command-output-delta', threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, delta: params.delta || '' };
    case 'item/fileChange/patchUpdated':
      return { ...base, type: 'codex-file-change-patch', threadId: params.threadId, turnId: params.turnId, itemId: params.itemId };
    case 'turn/diff/updated':
      return { ...base, type: 'codex-diff-updated', threadId: params.threadId, turnId: params.turnId };
    case 'error':
      return { ...base, type: 'codex-error', error: params };
    case 'warning':
    case 'guardianWarning':
    case 'configWarning':
      return { ...base, type: 'codex-warning', warning: params };
    default:
      return { ...base, type: 'codex-notification' };
  }
}

export function summarizeCodexEvents(events = []) {
  let text = '';
  let commandOutput = '';
  let reasoning = '';
  const items = [];
  for (const event of events) {
    if (event.type === 'codex-agent-delta' || event.type === 'codex-plan-delta') text += event.delta || '';
    if (event.type === 'codex-command-output-delta') commandOutput += event.delta || '';
    if (event.type === 'codex-reasoning-delta') reasoning += event.delta || '';
    if (event.item) items.push(event.item);
  }
  return { text, commandOutput, reasoning, items };
}

export class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      cwd: options.cwd || process.cwd(),
      autoApprove: Boolean(options.autoApprove),
      timeoutMs: Number(options.timeoutMs || 120_000),
      model: options.model || null,
      sandbox: options.sandbox || null,
      approvalPolicy: options.approvalPolicy || null,
      command: options.command || 'codex',
      args: options.args || ['app-server', '--stdio'],
      ...options
    };
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.requests = [];
    this.child = null;
    this.rl = null;
    this.started = false;
  }

  async start() {
    if (this.started) return;
    this.child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString('utf8')));
    this.child.on('exit', (code, signal) => {
      const error = new Error(`codex app-server exited (${code ?? 'null'} ${signal ?? ''})`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.emit('exit', { code, signal });
    });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => this.handleLine(line));
    await this.request('initialize', {
      clientInfo: { name: 'tricli_remote', title: 'TriCLI Remote', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    });
    this.notify('initialized', {});
    this.started = true;
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new Error('codex app-server stdin is not writable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    this.write({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  async handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit('parse-error', { line, error });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, 'id') && (message.result || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'Codex app-server error'), { rpcError: message.error }));
      else pending.resolve(message.result);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
      await this.handleServerRequest(message);
      return;
    }
    const event = mapCodexAppServerNotification(message);
    if (event) {
      this.events.push(event);
      this.emit('event', event);
    }
  }

  async handleServerRequest(message) {
    this.requests.push({ method: message.method, params: message.params, id: message.id, createdAt: new Date().toISOString() });
    this.emit('server-request', message);
    try {
      const result = this.defaultServerRequestResult(message);
      this.write({ id: message.id, result });
      this.emit('server-request-resolved', { id: message.id, method: message.method, result });
    } catch (error) {
      this.write({ id: message.id, error: { code: -32603, message: error.message } });
    }
  }

  defaultServerRequestResult(message) {
    if (message.method === 'currentTime/read') return { currentTimeAt: Math.floor(Date.now() / 1000) };
    if (message.method === 'item/commandExecution/requestApproval') return { decision: this.options.autoApprove ? 'accept' : 'decline' };
    if (message.method === 'item/fileChange/requestApproval') return { decision: this.options.autoApprove ? 'accept' : 'decline' };
    if (message.method === 'execCommandApproval') return { decision: this.options.autoApprove ? 'approved' : 'denied' };
    if (message.method === 'applyPatchApproval') return { decision: this.options.autoApprove ? 'approved' : 'denied' };
    if (message.method === 'item/tool/requestUserInput') {
      const answers = {};
      for (const question of message.params?.questions || []) {
        const first = question.options?.[0]?.label || '';
        answers[question.id] = { answers: first ? [first] : [] };
      }
      return { answers };
    }
    if (message.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    if (message.method === 'mcpServer/elicitation/request') return { action: { type: 'cancel' } };
    throw new Error(`Unhandled Codex app-server request: ${message.method}`);
  }

  async runTurn({ prompt, cwd, model, images = [], timeoutMs, autoApprove } = {}) {
    if (typeof autoApprove === 'boolean') this.options.autoApprove = autoApprove;
    await this.start();
    const threadParams = {
      cwd: cwd || this.options.cwd,
      ...(model || this.options.model ? { model: model || this.options.model } : {}),
      ...(this.options.sandbox ? { sandbox: this.options.sandbox } : {}),
      ...(this.options.approvalPolicy ? { approvalPolicy: this.options.approvalPolicy } : {})
    };
    const threadResult = await this.request('thread/start', threadParams);
    const threadId = threadResult.thread?.id;
    if (!threadId) throw new Error('Codex app-server did not return a thread id');
    const input = [{ type: 'text', text: String(prompt || ''), text_elements: [] }];
    for (const imagePath of images || []) input.push({ type: 'localImage', path: String(imagePath) });
    const turnResult = await this.request('turn/start', { threadId, input, cwd: cwd || this.options.cwd });
    const turnId = turnResult.turn?.id;
    if (!turnId) throw new Error('Codex app-server did not return a turn id');
    const completed = await this.waitForTurnCompleted(turnId, timeoutMs || this.options.timeoutMs).catch(async (error) => {
      try { await this.request('turn/interrupt', { threadId, turnId }); } catch {}
      throw error;
    });
    const summary = summarizeCodexEvents(this.events.filter((event) => !event.turnId || event.turnId === turnId));
    return { threadId, turnId, completed, events: this.events, requests: this.requests, summary };
  }

  waitForTurnCompleted(turnId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for Codex turn ${turnId}`));
      }, timeoutMs);
      const onEvent = (event) => {
        if (event.type === 'codex-turn-completed' && event.turnId === turnId) {
          cleanup();
          resolve(event);
        }
        if (event.type === 'codex-error') {
          cleanup();
          reject(new Error(`Codex app-server error: ${JSON.stringify(event.error)}`));
        }
      };
      const onExit = ({ code, signal }) => {
        cleanup();
        reject(new Error(`Codex app-server exited before turn completed (${code ?? 'null'} ${signal ?? ''})`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('event', onEvent);
        this.off('exit', onExit);
      };
      this.on('event', onEvent);
      this.on('exit', onExit);
    });
  }

  async dispose() {
    try { this.rl?.close(); } catch {}
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
  }
}

export async function runCodexAppServerTurn(options) {
  const client = new CodexAppServerClient(options);
  try {
    return await client.runTurn(options);
  } finally {
    await client.dispose();
  }
}
