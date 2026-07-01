export type ProviderId = 'codex' | 'claude' | 'cursor';

export type Machine = {
  machineId: string;
  name?: string;
  transport?: string;
  lastSeenAt?: string;
  online?: boolean;
};

export class TriCliClient {
  constructor(private readonly baseUrl: string, private readonly token = '') {}

  private headers(extra: Record<string, string> = {}) {
    return {
      'content-type': 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}`, 'x-tricli-token': this.token } : {}),
      ...extra
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: this.headers((init.headers || {}) as Record<string, string>)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
    return data as T;
  }

  listMachines() {
    return this.request<{ machines: Machine[] }>('/api/machines');
  }

  listSessions() {
    return this.request<any>('/api/sessions');
  }

  listAdapters() {
    return this.request<any>('/api/adapters');
  }

  startSession(provider: ProviderId, cwd = '/root') {
    return this.request<any>('/api/sessions', { method: 'POST', body: JSON.stringify({ provider, cwd }) });
  }

  stopSession(provider: ProviderId) {
    return this.request<any>(`/api/sessions/${provider}/stop`, { method: 'POST', body: '{}' });
  }

  snapshot(provider: ProviderId, lines = 260) {
    return this.request<{ output: string; capturedAt: string; analysis?: { status?: string } }>(`/api/sessions/${provider}/snapshot?lines=${lines}`);
  }

  send(provider: ProviderId, text: string) {
    return this.request<any>(`/api/sessions/${provider}/input`, { method: 'POST', body: JSON.stringify({ text }) });
  }

  keys(provider: ProviderId, keys: string[]) {
    return this.request<any>(`/api/sessions/${provider}/keys`, { method: 'POST', body: JSON.stringify({ keys }) });
  }

  approvals(provider: ProviderId) {
    return this.request<{ approvals: any[] }>(`/api/approvals?provider=${provider}`);
  }

  respondApproval(id: string, response: any) {
    return this.request<any>(`/api/approvals/${encodeURIComponent(id)}/respond`, { method: 'POST', body: JSON.stringify(response) });
  }

  upload(provider: ProviderId, filename: string, contentBase64: string) {
    return this.request<{ path: string }>('/api/upload', { method: 'POST', body: JSON.stringify({ provider, filename, contentBase64 }) });
  }

  listJobs(provider: ProviderId) {
    return this.request<{ jobs: any[] }>(`/api/jobs?provider=${provider}`);
  }

  runJob(provider: ProviderId, args: string[], cwd = '/root') {
    return this.request<any>('/api/jobs', { method: 'POST', body: JSON.stringify({ provider, args, cwd }) });
  }

  killJob(id: string) {
    return this.request<any>(`/api/jobs/${encodeURIComponent(id)}/kill`, { method: 'POST', body: '{}' });
  }

  listStructuredTurns(provider: ProviderId) {
    return this.request<{ turns: any[] }>(`/api/structured/${provider}/turns`);
  }

  runStructuredTurn(provider: ProviderId, prompt: string, cwd = '/root') {
    const body: any = { prompt, cwd, autoApprove: false };
    if (provider === 'claude') body.permissionMode = 'plan';
    if (provider === 'cursor') body.mode = 'plan';
    return this.request<any>(`/api/structured/${provider}/turn`, { method: 'POST', body: JSON.stringify(body) });
  }

  killStructuredTurn(provider: ProviderId, id: string) {
    return this.request<any>(`/api/structured/${provider}/turns/${encodeURIComponent(id)}/kill`, { method: 'POST', body: '{}' });
  }
}
