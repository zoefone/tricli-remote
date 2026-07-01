export const PROVIDERS = Object.freeze([
  {
    id: 'codex',
    label: 'Codex',
    workCommand: 'codex-work',
    tmuxSession: 'ai-codex',
    accent: '#22C55E',
    supportsImages: true,
    structured: 'codex app-server JSON-RPC',
    fallback: 'tmux PTY via codex-work/ai-work'
  },
  {
    id: 'claude',
    label: 'Claude Code',
    workCommand: 'claude-work',
    tmuxSession: 'ai-claude',
    accent: '#3B82F6',
    supportsImages: false,
    structured: 'claude stream-json',
    fallback: 'tmux PTY via claude-work/ai-work'
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    workCommand: 'cursor-work',
    tmuxSession: 'ai-cursor',
    accent: '#F8FAFC',
    supportsImages: false,
    structured: 'cursor-agent ACP / stream-json --resume',
    fallback: 'tmux PTY via cursor-work/ai-work'
  }
]);

export const PROVIDER_IDS = new Set(PROVIDERS.map((provider) => provider.id));

export function assertProvider(provider) {
  if (!PROVIDER_IDS.has(provider)) {
    const allowed = [...PROVIDER_IDS].join(', ');
    const error = new Error(`Unknown provider '${provider}'. Allowed: ${allowed}`);
    error.statusCode = 400;
    throw error;
  }
  return provider;
}

export function getProvider(provider) {
  assertProvider(provider);
  return PROVIDERS.find((item) => item.id === provider);
}

export function createEvent(type, payload = {}) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    createdAt: new Date().toISOString(),
    ...payload
  };
}

export function sanitizeFilename(name) {
  const base = String(name || 'upload.bin').split(/[\\/]/).pop() || 'upload.bin';
  return base.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180) || 'upload.bin';
}

export function jsonResponse(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-tricli-token',
    ...extraHeaders
  });
  res.end(data);
}

export function textResponse(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-tricli-token'
  });
  res.end(body);
}

export async function readJsonBody(req, limitBytes = 50 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const error = new Error(`Request body too large (${size} bytes)`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (cause) {
    const error = new Error('Invalid JSON body');
    error.statusCode = 400;
    error.cause = cause;
    throw error;
  }
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}
