import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (!block || typeof block !== 'object') return '';
    if (typeof block.text === 'string') return block.text;
    if (typeof block.content === 'string') return block.content;
    if (block.type === 'tool_use') return `[tool:${block.name || 'unknown'}]`;
    if (block.type === 'tool_result') return `[tool-result:${block.tool_use_id || 'unknown'}]`;
    return '';
  }).join('');
}

export function mapCursorStreamJsonMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const base = { provider: 'cursor', adapter: 'cursor-stream-json', raw: message };
  if (message.type === 'system') {
    return { ...base, type: 'cursor-system', sessionId: message.session_id || message.sessionId || message.chatId || null, subtype: message.subtype || null };
  }
  if (message.type === 'assistant') {
    const content = message.message?.content ?? message.content ?? '';
    const text = contentToText(content);
    const toolUses = Array.isArray(content) ? content.filter((block) => block?.type === 'tool_use') : [];
    return { ...base, type: toolUses.length ? 'cursor-tool-use' : 'cursor-assistant', text, toolUses };
  }
  if (message.type === 'user') {
    const content = message.message?.content ?? message.content ?? '';
    const text = contentToText(content);
    const toolResults = Array.isArray(content) ? content.filter((block) => block?.type === 'tool_result') : [];
    return { ...base, type: toolResults.length ? 'cursor-tool-result' : 'cursor-user', text, toolResults };
  }
  if (message.type === 'thinking') return { ...base, type: 'cursor-thinking', text: message.text || message.content || '' };
  if (message.type === 'result') return { ...base, type: 'cursor-result', subtype: message.subtype || null, isError: Boolean(message.is_error || message.isError), result: message.result || message.message || '', durationMs: message.duration_ms || message.durationMs || null };
  if (message.type === 'error') return { ...base, type: 'cursor-error', error: message.error || message.message || message };
  return { ...base, type: 'cursor-event' };
}

export function summarizeCursorEvents(events = []) {
  let text = '';
  let reasoning = '';
  let result = '';
  const tools = [];
  let sessionId = null;
  for (const event of events) {
    if (event.sessionId) sessionId = event.sessionId;
    if (event.type === 'cursor-assistant') text += event.text || '';
    if (event.type === 'cursor-tool-use') {
      if (event.text) text += event.text;
      tools.push(...(event.toolUses || []));
    }
    if (event.type === 'cursor-thinking') reasoning += event.text || '';
    if (event.type === 'cursor-result') result += event.result || '';
  }
  return { text, reasoning, result, tools, sessionId };
}

export class CursorStreamJsonClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      cwd: options.cwd || process.cwd(),
      timeoutMs: Number(options.timeoutMs || 120_000),
      model: options.model || null,
      mode: options.mode || null,
      resume: options.resume || null,
      force: Boolean(options.force),
      extraArgs: Array.isArray(options.extraArgs) ? options.extraArgs.map(String) : [],
      command: options.command || 'cursor-agent',
      ...options
    };
    this.events = [];
    this.child = null;
    this.rl = null;
  }

  buildArgs(prompt) {
    const args = ['-p', '--output-format', 'stream-json', '--trust'];
    if (this.options.model) args.push('--model', this.options.model);
    if (this.options.mode) args.push('--mode', this.options.mode);
    if (this.options.resume) args.push('--resume', this.options.resume);
    if (this.options.force) args.push('--force');
    if (this.options.cwd) args.push('--workspace', this.options.cwd);
    args.push(...this.options.extraArgs);
    args.push(String(prompt || ''));
    return args;
  }

  run({ prompt, timeoutMs, cwd } = {}) {
    return new Promise((resolve, reject) => {
      const args = this.buildArgs(prompt);
      const timer = setTimeout(() => {
        this.dispose();
        reject(new Error('Timed out waiting for Cursor Agent stream-json process'));
      }, timeoutMs || this.options.timeoutMs);
      const cleanup = () => clearTimeout(timer);
      this.child = spawn(this.options.command, args, { cwd: cwd || this.options.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      this.child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-256 * 1024);
        this.emit('stderr', chunk.toString('utf8'));
      });
      this.rl = createInterface({ input: this.child.stdout });
      this.rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const raw = JSON.parse(line);
          const event = mapCursorStreamJsonMessage(raw);
          if (event) {
            this.events.push(event);
            this.emit('event', event);
          }
        } catch (error) {
          this.emit('parse-error', { line, error });
        }
      });
      this.child.on('error', (error) => {
        cleanup();
        reject(error);
      });
      this.child.on('close', (code, signal) => {
        cleanup();
        const summary = summarizeCursorEvents(this.events);
        if (code === 0) resolve({ status: 'completed', code, signal, stderr, events: this.events, summary });
        else resolve({ status: 'failed', code, signal, stderr, events: this.events, summary });
      });
    });
  }

  async dispose() {
    try { this.rl?.close(); } catch {}
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
  }
}

export async function runCursorStreamJsonTurn(options) {
  const client = new CursorStreamJsonClient(options);
  try {
    return await client.run(options);
  } finally {
    await client.dispose();
  }
}
