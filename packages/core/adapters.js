import { execFile } from 'node:child_process';
import { PROVIDERS, assertProvider, createEvent } from './protocol.js';

export const ADAPTER_KINDS = Object.freeze({
  workCommand: 'work-command',
  codexAppServer: 'codex-app-server',
  claudeStreamJson: 'claude-stream-json',
  cursorStreamJson: 'cursor-stream-json',
  cursorAcp: 'cursor-acp'
});

export function execFileText(command, args = [], options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: options.timeout || 5000,
      maxBuffer: options.maxBuffer || 2 * 1024 * 1024,
      env: { ...process.env, ...(options.env || {}) }
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout, stderr, error: error?.message || null });
    });
  });
}

export async function probeProviderAdapters() {
  const [codexHelp, claudeHelp, cursorHelp, cursorAcpHelp] = await Promise.all([
    execFileText('codex', ['app-server', '--help']),
    execFileText('claude', ['--help']),
    execFileText('cursor-agent', ['--help']),
    execFileText('cursor-agent', ['acp', '--help'])
  ]);
  return PROVIDERS.map((provider) => {
    const adapters = [
      {
        kind: ADAPTER_KINDS.workCommand,
        available: true,
        stable: true,
        description: `Persistent tmux fallback through ${provider.workCommand}/ai-work`
      }
    ];
    if (provider.id === 'codex') {
      adapters.push({
        kind: ADAPTER_KINDS.codexAppServer,
        available: codexHelp.ok && /app server|app-server/i.test(`${codexHelp.stdout}\n${codexHelp.stderr}`),
        stable: false,
        description: 'Codex app-server JSON-RPC for threads, turns, approvals, diffs and streamed events'
      });
    }
    if (provider.id === 'claude') {
      const text = `${claudeHelp.stdout}\n${claudeHelp.stderr}`;
      adapters.push({
        kind: ADAPTER_KINDS.claudeStreamJson,
        available: claudeHelp.ok && /--output-format/.test(text) && /stream-json/.test(text),
        stable: true,
        description: 'Claude Code --input-format/--output-format stream-json structured event adapter'
      });
    }
    if (provider.id === 'cursor') {
      const cursorText = `${cursorHelp.stdout}\n${cursorHelp.stderr}`;
      adapters.push({
        kind: ADAPTER_KINDS.cursorStreamJson,
        available: cursorHelp.ok && /--output-format/.test(cursorText) && /stream-json/.test(cursorText),
        stable: true,
        description: 'Cursor Agent -p --output-format stream-json for headless turns, resumable chat IDs and streamed events'
      });
      adapters.push({
        kind: ADAPTER_KINDS.cursorAcp,
        available: cursorAcpHelp.ok && /ACP|Agent Client Protocol/i.test(`${cursorAcpHelp.stdout}\n${cursorAcpHelp.stderr}`),
        stable: false,
        description: 'Cursor Agent ACP server readiness probe for future richer IDE-style lifecycle control'
      });
    }
    return { ...provider, adapters };
  });
}

const APPROVAL_PATTERNS = [
  { kind: 'permission', re: /\b(approve|approval|allow|permission|permissions|run this command|execute this command)\b/i },
  { kind: 'choice', re: /\b(choose|select|option|方案|选择|请选择|是否|批准|允许|权限)\b/i },
  { kind: 'danger', re: /\b(danger|dangerous|destructive|delete|remove|overwrite|bypass|full access)\b/i }
];

export function analyzeSnapshot(provider, output, options = {}) {
  assertProvider(provider);
  const text = String(output || '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-80);
  const lower = text.toLowerCase();
  let status = 'idle';
  if (/\b(running|working|thinking|executing|正在|运行中|处理中)\b/i.test(text)) status = 'running';
  if (/\b(error|failed|失败|错误|denied)\b/i.test(text)) status = 'attention';
  if (/\b(done|completed|ready|finished|完成|已完成)\b/i.test(text)) status = 'ready';

  const approvals = [];
  tail.forEach((line, index) => {
    const matched = APPROVAL_PATTERNS.filter((pattern) => pattern.re.test(line));
    if (matched.length === 0) return;
    const normalized = line.trim().replace(/\s+/g, ' ').slice(0, 500);
    approvals.push({
      provider,
      kind: matched.some((item) => item.kind === 'danger') ? 'danger' : matched[0].kind,
      title: matched.some((item) => item.kind === 'choice') ? 'Needs choice' : 'Needs approval',
      message: normalized,
      lineNumberFromTail: index - tail.length,
      source: 'terminal-snapshot'
    });
  });

  const structuredMarkers = {
    hasDiff: /diff --git|\+\+\+ b\//.test(text),
    hasCommand: /\b(Ran|Running|Command|Bash|shell|exec)\b/i.test(text),
    hasFileChange: /\b(modified|created|deleted|updated|wrote|编辑|创建|删除)\b/i.test(text),
    hasImageReference: /\.(png|jpg|jpeg|webp|gif)\b/i.test(lower)
  };

  return {
    provider,
    status,
    lineCount: lines.length,
    charCount: text.length,
    analyzedAt: new Date().toISOString(),
    approvals,
    structuredMarkers
  };
}

export function mergeDetectedApprovals(existingApprovals = [], detected = [], context = {}) {
  const now = new Date().toISOString();
  const existing = [...existingApprovals];
  for (const approval of detected) {
    const fingerprint = `${approval.provider}:${approval.kind}:${approval.message}`;
    const found = existing.find((item) => item.fingerprint === fingerprint && item.status === 'pending');
    if (found) {
      found.lastSeenAt = now;
      continue;
    }
    existing.push({
      id: `apr_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      fingerprint,
      status: 'pending',
      createdAt: now,
      lastSeenAt: now,
      response: null,
      ...context,
      ...approval
    });
  }
  return existing.slice(-200);
}

export function approvalResponseToKeys(response) {
  const decision = String(response?.decision || response?.text || '').toLowerCase();
  if (response?.keys && Array.isArray(response.keys)) return response.keys.map(String);
  if (['yes', 'y', 'approve', 'approved', 'allow', 'accept', '1', '确认', '同意', '允许'].includes(decision)) return ['y', 'Enter'];
  if (['no', 'n', 'deny', 'reject', 'cancel', '2', '拒绝', '取消'].includes(decision)) return ['n', 'Enter'];
  if (response?.text) return [String(response.text), 'Enter'];
  return ['Enter'];
}

export function eventFromSnapshotAnalysis(analysis) {
  return createEvent('snapshot-analyzed', {
    provider: analysis.provider,
    status: analysis.status,
    approvals: analysis.approvals.length,
    structuredMarkers: analysis.structuredMarkers
  });
}
