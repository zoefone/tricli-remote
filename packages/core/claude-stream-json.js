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

export function mapClaudeStreamJsonMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const base = { provider: 'claude', adapter: 'claude-stream-json', raw: message };
  if (message.type === 'system') {
    return { ...base, type: 'claude-system', sessionId: message.session_id || message.sessionId || null, subtype: message.subtype || null };
  }
  if (message.type === 'assistant') {
    const content = message.message?.content ?? message.content ?? '';
    const text = contentToText(content);
    const toolUses = Array.isArray(content) ? content.filter((block) => block?.type === 'tool_use') : [];
    return { ...base, type: toolUses.length ? 'claude-tool-use' : 'claude-assistant', text, toolUses };
  }
  if (message.type === 'user') {
    const content = message.message?.content ?? message.content ?? '';
    const text = contentToText(content);
    const toolResults = Array.isArray(content) ? content.filter((block) => block?.type === 'tool_result') : [];
    return { ...base, type: toolResults.length ? 'claude-tool-result' : 'claude-user', text, toolResults };
  }
  if (message.type === 'thinking') {
    return { ...base, type: 'claude-thinking', text: message.text || message.content || '' };
  }
  if (message.type === 'result') {
    return { ...base, type: 'claude-result', subtype: message.subtype || null, isError: Boolean(message.is_error || message.isError), result: message.result || message.message || '', durationMs: message.duration_ms || message.durationMs || null };
  }
  if (message.type === 'error') {
    return { ...base, type: 'claude-error', error: message.error || message.message || message };
  }
  return { ...base, type: 'claude-event' };
}

export function summarizeClaudeEvents(events = []) {
  let text = '';
  let reasoning = '';
  const tools = [];
  let result = '';
  for (const event of events) {
    if (event.type === 'claude-assistant') text += event.text || '';
    if (event.type === 'claude-tool-use') {
      if (event.text) text += event.text;
      tools.push(...(event.toolUses || []));
    }
    if (event.type === 'claude-thinking') reasoning += event.text || '';
    if (event.type === 'claude-result') result += event.result || '';
  }
  return { text, reasoning, result, tools };
}

export class ClaudeStreamJsonClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      cwd: options.cwd || process.cwd(),
      timeoutMs: Number(options.timeoutMs || 120_000),
      model: options.model || null,
      permissionMode: options.permissionMode || null,
      extraArgs: Array.isArray(options.extraArgs) ? options.extraArgs.map(String) : [],
      command: options.command || 'claude',
      ...options
    };
    this.events = [];
    this.child = null;
    this.rl = null;
  }

  buildArgs(prompt) {
    const args = ['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'];
    if (this.options.model) args.push('--model', this.options.model);
    if (this.options.permissionMode) args.push('--permission-mode', this.options.permissionMode);
    args.push(...this.options.extraArgs);
    args.push(String(prompt || ''));
    return args;
  }

  run({ prompt, timeoutMs, cwd } = {}) {
    return new Promise((resolve, reject) => {
      const args = this.buildArgs(prompt);
      const timer = setTimeout(() => {
        this.dispose();
        reject(new Error('Timed out waiting for Claude stream-json process'));
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
          const event = mapClaudeStreamJsonMessage(raw);
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
        const summary = summarizeClaudeEvents(this.events);
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

export async function runClaudeStreamJsonTurn(options) {
  const client = new ClaudeStreamJsonClient(options);
  try {
    return await client.run(options);
  } finally {
    await client.dispose();
  }
}
