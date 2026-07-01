const providers = [
  { id: 'codex', label: 'Codex', accent: '#22C55E' },
  { id: 'claude', label: 'Claude Code', accent: '#38BDF8' },
  { id: 'cursor', label: 'Cursor Agent', accent: '#F8FAFC' }
];

const state = {
  provider: 'codex',
  mode: 'server',
  machineId: null,
  directUrl: localStorage.getItem('tricli.directUrl') || '',
  token: localStorage.getItem('tricli.token') || '',
  serverBase: '',
  timer: null
};

const $ = (id) => document.getElementById(id);
const terminal = $('terminal');
const events = $('events');
const uploads = $('uploads');
const approvalsRoot = $('approvals');
const adapterInfo = $('adapterInfo');
const jobsRoot = $('jobs');
const structuredTurnsRoot = $('structuredTurns');
const connectionLabel = $('connectionLabel');
const connectionHint = $('connectionHint');
const runningBadge = $('runningBadge');
const terminalMeta = $('terminalMeta');

function addEvent(message, type = 'info') {
  const node = document.createElement('div');
  node.className = 'event';
  node.textContent = `${new Date().toLocaleTimeString()} · ${message}`;
  events.prepend(node);
}

function apiBase() {
  if (state.mode === 'direct') return state.directUrl.replace(/\/$/, '');
  if (!state.machineId) return '';
  return `/api/machines/${encodeURIComponent(state.machineId)}/daemon`;
}

async function request(path, options = {}) {
  const base = apiBase();
  if (!base) throw new Error('未选择连接');
  const authHeaders = state.token ? { authorization: `Bearer ${state.token}`, 'x-tricli-token': state.token } : {};
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...authHeaders, ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}




async function loadStructuredTurns() {
  if (!apiBase()) return;
  try {
    const data = await request(`/api/structured/${state.provider}/turns`);
    structuredTurnsRoot.innerHTML = '';
    const turns = (data.turns || []).slice(0, 5);
    if (!turns.length) {
      structuredTurnsRoot.innerHTML = '<div class="event">暂无 structured turn</div>';
      return;
    }
    for (const turn of turns) {
      const node = document.createElement('div');
      node.className = 'machine';
      node.innerHTML = `<strong>${turn.status} · ${turn.promptPreview || turn.id}</strong><small>${turn.adapter} · ${turn.id} · events ${turn.eventCount} · text ${turn.textBytes}B</small>`;
      const actions = document.createElement('div');
      actions.className = 'mini-actions';
      const open = document.createElement('button');
      open.className = 'ghost mini';
      open.textContent = '查看';
      open.onclick = () => showStructuredTurn(turn.id);
      actions.append(open);
      if (['starting', 'running'].includes(turn.status)) {
        const kill = document.createElement('button');
        kill.className = 'danger mini';
        kill.textContent = '停止';
        kill.onclick = () => killStructuredTurn(turn.id);
        actions.append(kill);
      }
      node.append(actions);
      structuredTurnsRoot.append(node);
    }
  } catch (error) {
    structuredTurnsRoot.innerHTML = `<div class="event">structured turn 加载失败：${error.message}</div>`;
  }
}

async function runStructuredCodex() {
  const promptText = $('prompt').value.trim();
  if (!promptText) throw new Error('请先在输入框写 prompt');
  const body = { prompt: promptText, cwd: $('cwd').value || '/root', autoApprove: false };
  if (state.provider === 'cursor') body.mode = 'plan';
  if (state.provider === 'claude') body.permissionMode = 'plan';
  const data = await request(`/api/structured/${state.provider}/turn`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  addEvent(`${state.provider} structured turn 已启动：${data.turn.id}`);
  await loadStructuredTurns();
}

async function showStructuredTurn(id) {
  const data = await request(`/api/structured/${state.provider}/turns/${encodeURIComponent(id)}`);
  const summary = data.summary || {};
  const tools = Array.isArray(summary.tools) && summary.tools.length
    ? JSON.stringify(summary.tools, null, 2)
    : '';
  terminal.textContent = `# ${state.provider} structured turn ${id}
status: ${data.turn.status}
thread: ${data.turn.threadId || '-'}
turn: ${data.turn.turnId || '-'}
adapter: ${data.turn.adapter || '-'}

# assistant
${summary.text || ''}

# reasoning
${summary.reasoning || ''}

# result
${summary.result || ''}

# command output
${summary.commandOutput || ''}

# tools
${tools}

# stderr
${data.stderr || ''}`;
  terminal.scrollTop = terminal.scrollHeight;
  terminalMeta.textContent = `structured ${id} · ${data.turn.status}`;
}

async function killStructuredTurn(id) {
  await request(`/api/structured/${state.provider}/turns/${encodeURIComponent(id)}/kill`, { method: 'POST', body: '{}' });
  addEvent(`structured turn 已停止：${id}`);
  await loadStructuredTurns();
}

function splitArgs(text) {
  const matches = String(text || '').match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g) || [];
  return matches.map((item) => item.replace(/^['"]|['"]$/g, ''));
}

async function loadJobs() {
  if (!apiBase()) return;
  try {
    const data = await request(`/api/jobs?provider=${state.provider}`);
    jobsRoot.innerHTML = '';
    const jobs = (data.jobs || []).slice(0, 6);
    if (!jobs.length) {
      jobsRoot.innerHTML = '<div class="event">暂无 CLI job</div>';
      return;
    }
    for (const job of jobs) {
      const node = document.createElement('div');
      node.className = 'machine';
      node.innerHTML = `<strong>${job.status} · ${job.command} ${job.args.join(' ')}</strong><small>${job.id} · stdout ${job.stdoutBytes}B · stderr ${job.stderrBytes}B</small>`;
      const actions = document.createElement('div');
      actions.className = 'mini-actions';
      const open = document.createElement('button');
      open.className = 'ghost mini';
      open.textContent = '查看';
      open.onclick = () => showJob(job.id);
      actions.append(open);
      if (['starting', 'running'].includes(job.status)) {
        const kill = document.createElement('button');
        kill.className = 'danger mini';
        kill.textContent = '停止';
        kill.onclick = () => killJob(job.id);
        actions.append(kill);
      }
      node.append(actions);
      jobsRoot.append(node);
    }
  } catch (error) {
    jobsRoot.innerHTML = `<div class="event">Job 加载失败：${error.message}</div>`;
  }
}

async function runJob() {
  const args = splitArgs($('jobArgs').value || '--help');
  const data = await request('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ provider: state.provider, args, cwd: $('cwd').value || '/root' })
  });
  addEvent(`CLI job 已启动：${data.job.id}`);
  await loadJobs();
}

async function showJob(id) {
  const data = await request(`/api/jobs/${encodeURIComponent(id)}`);
  terminal.textContent = `$ ${data.job.command} ${data.job.args.join(' ')}

# stdout
${data.stdout}

# stderr
${data.stderr}`;
  terminal.scrollTop = terminal.scrollHeight;
  terminalMeta.textContent = `job ${id} · ${data.job.status}`;
}

async function killJob(id) {
  await request(`/api/jobs/${encodeURIComponent(id)}/kill`, { method: 'POST', body: '{}' });
  addEvent(`CLI job 已请求停止：${id}`);
  await loadJobs();
}

async function loadAdapters() {
  if (!apiBase()) return;
  try {
    const data = await request('/api/adapters');
    const provider = data.providers?.find((item) => item.id === state.provider);
    const adapters = provider?.adapters || [];
    adapterInfo.innerHTML = adapters.map((adapter) => {
      const color = adapter.available ? '#22C55E' : '#94A3B8';
      return `<div><span style="color:${color}">●</span> <strong>${adapter.kind}</strong> · ${adapter.available ? '可用' : '不可用'} · ${adapter.description}</div>`;
    }).join('') || '暂无适配器信息';
  } catch (error) {
    adapterInfo.textContent = `适配器检测失败：${error.message}`;
  }
}

async function loadApprovals() {
  if (!apiBase()) return;
  try {
    const data = await request(`/api/approvals?provider=${state.provider}`);
    const pending = (data.approvals || []).filter((item) => item.status === 'pending').reverse();
    approvalsRoot.innerHTML = '';
    if (!pending.length) {
      approvalsRoot.innerHTML = '<div class="event">暂无待审批/待选择项</div>';
      return;
    }
    for (const approval of pending) {
      const node = document.createElement('div');
      node.className = 'approval';
      node.innerHTML = `<strong>${approval.title || 'Needs approval'}</strong><span>${approval.message}</span><small>${approval.createdAt}</small>`;
      const actions = document.createElement('div');
      actions.className = 'approval-actions';
      const approve = document.createElement('button');
      approve.className = 'primary';
      approve.textContent = '允许/确认';
      approve.onclick = () => respondApproval(approval.id, { decision: 'approve' });
      const deny = document.createElement('button');
      deny.className = 'danger';
      deny.textContent = '拒绝/取消';
      deny.onclick = () => respondApproval(approval.id, { decision: 'deny' });
      const enter = document.createElement('button');
      enter.className = 'ghost';
      enter.textContent = 'Enter';
      enter.onclick = () => respondApproval(approval.id, { keys: ['Enter'], decision: 'enter' });
      actions.append(approve, deny, enter);
      node.append(actions);
      approvalsRoot.append(node);
    }
  } catch (error) {
    approvalsRoot.innerHTML = `<div class="event">审批加载失败：${error.message}</div>`;
  }
}

async function respondApproval(id, response) {
  await request(`/api/approvals/${encodeURIComponent(id)}/respond`, {
    method: 'POST',
    body: JSON.stringify(response)
  });
  addEvent(`审批已响应：${id}`);
  await loadApprovals();
  setTimeout(refreshSnapshot, 500);
}

function renderProviders() {
  const root = $('providerTabs');
  root.innerHTML = '';
  for (const provider of providers) {
    const button = document.createElement('button');
    button.className = `tab ${state.provider === provider.id ? 'active' : ''}`;
    button.style.setProperty('--green', provider.accent);
    button.textContent = provider.label;
    button.onclick = () => {
      state.provider = provider.id;
      renderProviders();
      void loadAdapters();
      void loadJobs();
      void loadStructuredTurns();
      void refreshSnapshot();
    };
    root.append(button);
  }
}

async function loadMachines() {
  try {
    const res = await fetch('/api/machines', { headers: state.token ? { authorization: `Bearer ${state.token}`, 'x-tricli-token': state.token } : {} });
    const data = await res.json();
    const list = $('machineList');
    list.innerHTML = '';
    if (!data.machines?.length) {
      list.innerHTML = '<p>暂无已注册机器。跨网时请在目标机器运行 daemon --server-url。</p>';
      return;
    }
    for (const machine of data.machines) {
      const item = document.createElement('button');
      item.className = 'machine';
      item.innerHTML = `<strong>${machine.name || machine.machineId}</strong><small>${machine.machineId} · ${machine.transport || 'unknown'} · ${machine.lastSeenAt || ''}</small>`;
      item.onclick = () => {
        state.mode = 'server';
        state.machineId = machine.machineId;
        updateConnection();
        void refreshSnapshot();
      };
      list.append(item);
    }
  } catch (error) {
    addEvent(`加载机器失败：${error.message}`, 'error');
  }
}

function updateConnection() {
  if (state.mode === 'direct') {
    connectionLabel.textContent = 'LAN 直连';
    connectionHint.textContent = state.directUrl || '未设置 direct URL';
  } else {
    connectionLabel.textContent = state.machineId ? '服务器 Relay' : '未选择机器';
    connectionHint.textContent = state.machineId || '等待选择机器';
  }
}

async function startSession() {
  const cwd = $('cwd').value || '/root';
  const data = await request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ provider: state.provider, cwd })
  });
  addEvent(`${state.provider} ${data.output}`);
  await refreshSnapshot();
}

async function stopSession() {
  await request(`/api/sessions/${state.provider}/stop`, { method: 'POST', body: '{}' });
  addEvent(`${state.provider} stopped`);
  await refreshSnapshot();
}

async function refreshSnapshot() {
  try {
    const data = await request(`/api/sessions/${state.provider}/snapshot?lines=260`);
    terminal.textContent = data.output || '(empty)';
    terminal.scrollTop = terminal.scrollHeight;
    terminalMeta.textContent = `${state.provider} · ${data.capturedAt}`;
    if (data.analysis?.status) runningBadge.textContent = data.analysis.status;
    void loadApprovals();
    void loadJobs();
    if (!data.analysis?.status) runningBadge.textContent = 'running';
    runningBadge.className = data.analysis?.status === 'attention' ? 'badge' : 'badge running';
  } catch (error) {
    terminal.textContent = error.message;
    terminalMeta.textContent = '未运行或无法同步';
    runningBadge.textContent = 'idle';
    runningBadge.className = 'badge muted';
  }
}

async function sendPrompt() {
  const text = $('prompt').value.trim();
  if (!text) return;
  await request(`/api/sessions/${state.provider}/input`, {
    method: 'POST',
    body: JSON.stringify({ text })
  });
  $('prompt').value = '';
  addEvent(`已发送到 ${state.provider}`);
  setTimeout(refreshSnapshot, 700);
}

async function sendKey(key) {
  await request(`/api/sessions/${state.provider}/keys`, {
    method: 'POST',
    body: JSON.stringify({ keys: [key] })
  });
  addEvent(`${state.provider} key ${key}`);
  setTimeout(refreshSnapshot, 300);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function uploadFiles() {
  const files = [...$('fileInput').files];
  for (const file of files) {
    const contentBase64 = await fileToBase64(file);
    const data = await request('/api/upload', {
      method: 'POST',
      body: JSON.stringify({ provider: state.provider, filename: file.name, contentBase64 })
    });
    const item = document.createElement('div');
    item.className = 'upload';
    item.textContent = `${file.name} → ${data.path}`;
    uploads.prepend(item);
    await request(`/api/sessions/${state.provider}/input`, {
      method: 'POST',
      body: JSON.stringify({ text: `已上传文件，请使用这个本地路径作为附件/参考：${data.path}` })
    }).catch(() => {});
  }
  addEvent(`上传完成：${files.length} 个文件`);
}

function initEvents() {
  try {
    const sseUrl = state.token ? `/api/events?token=${encodeURIComponent(state.token)}` : '/api/events';
    const sse = new EventSource(sseUrl);
    sse.addEventListener('machines', () => loadMachines());
    sse.addEventListener('machine-registered', (ev) => addEvent(`机器注册：${JSON.parse(ev.data).machineId}`));
    sse.addEventListener('relay-command-completed', (ev) => addEvent(`relay 完成：${JSON.parse(ev.data).commandId}`));
  } catch {}
}

$('directUrl').value = state.directUrl;
$('tokenInput').value = state.token;
$('tokenInput').onchange = () => {
  state.token = $('tokenInput').value.trim();
  localStorage.setItem('tricli.token', state.token);
};
$('useDirect').onclick = () => {
  state.directUrl = $('directUrl').value.trim();
  state.token = $('tokenInput').value.trim();
  localStorage.setItem('tricli.directUrl', state.directUrl);
  localStorage.setItem('tricli.token', state.token);
  state.mode = 'direct';
  state.machineId = null;
  updateConnection();
  void loadAdapters();
  void refreshSnapshot();
};
$('useServer').onclick = () => {
  state.token = $('tokenInput').value.trim();
  localStorage.setItem('tricli.token', state.token);
  state.mode = 'server';
  updateConnection();
  void loadMachines();
  void loadAdapters();
};
$('refreshMachines').onclick = loadMachines;
$('startSession').onclick = () => startSession().catch((e) => addEvent(e.message));
$('stopSession').onclick = () => stopSession().catch((e) => addEvent(e.message));
$('refreshSnapshot').onclick = () => refreshSnapshot();
$('sendPrompt').onclick = () => sendPrompt().catch((e) => addEvent(e.message));
$('uploadFiles').onclick = () => uploadFiles().catch((e) => addEvent(e.message));
$('runJob').onclick = () => runJob().catch((e) => addEvent(e.message));
$('runStructuredCodex').onclick = () => runStructuredCodex().catch((e) => addEvent(e.message));
document.querySelectorAll('.keyBtn').forEach((button) => button.addEventListener('click', () => sendKey(button.dataset.key).catch((e) => addEvent(e.message))));
setInterval(() => { if (apiBase()) refreshSnapshot().catch(() => {}); }, 5000);
renderProviders();
updateConnection();
void loadMachines();
void loadAdapters();
void loadApprovals();
void loadJobs();
void loadStructuredTurns();
initEvents();
