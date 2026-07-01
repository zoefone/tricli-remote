import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { theme } from './src/theme';
import { Machine, ProviderId, TriCliClient } from './src/tricliClient';
import { configureNotifications, notifyLocal } from './src/notifications';

const providers: Array<{ id: ProviderId; label: string; color: string }> = [
  { id: 'codex', label: 'Codex', color: theme.colors.green },
  { id: 'claude', label: 'Claude', color: theme.colors.blue },
  { id: 'cursor', label: 'Cursor', color: theme.colors.text }
];

function splitArgs(text: string) {
  return (text.match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*')+/g) || []).map((item) => item.replace(/^["']|["']$/g, ''));
}

function StatusPill({ text, tone = 'muted' }: { text: string; tone?: 'muted' | 'ok' | 'warn' | 'danger' }) {
  return <Text style={[styles.pill, styles[`pill_${tone}`]]}>{text}</Text>;
}

export default function App() {
  const [controlUrl, setControlUrl] = useState('http://127.0.0.1:7320');
  const [token, setToken] = useState('');
  const [machineId, setMachineId] = useState('');
  const [machines, setMachines] = useState<Machine[]>([]);
  const [provider, setProvider] = useState<ProviderId>('codex');
  const [cwd, setCwd] = useState('/root');
  const [prompt, setPrompt] = useState('');
  const [jobArgs, setJobArgs] = useState('--help');
  const [terminal, setTerminal] = useState('连接 daemon 或 relay 机器后点击“启动/接管”。');
  const [status, setStatus] = useState('idle');
  const [approvals, setApprovals] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [turns, setTurns] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  const effectiveBaseUrl = machineId
    ? `${controlUrl.replace(/\/$/, '')}/api/machines/${encodeURIComponent(machineId)}/daemon`
    : controlUrl;
  const serverClient = useMemo(() => new TriCliClient(controlUrl, token), [controlUrl, token]);
  const client = useMemo(() => new TriCliClient(effectiveBaseUrl, token), [effectiveBaseUrl, token]);

  useEffect(() => { void configureNotifications(); }, []);

  async function run(action: () => Promise<any>) {
    try {
      setBusy(true);
      await action();
    } catch (error: any) {
      Alert.alert('TriCLI Remote', error.message || String(error));
    } finally {
      setBusy(false);
    }
  }

  async function refreshSnapshot() {
    const snap = await client.snapshot(provider);
    setTerminal(snap.output || '(empty)');
    setStatus(snap.analysis?.status || 'running');
  }

  async function refreshSidePanels() {
    const [approvalData, jobData, turnData] = await Promise.all([
      client.approvals(provider).catch(() => ({ approvals: [] })),
      client.listJobs(provider).catch(() => ({ jobs: [] })),
      client.listStructuredTurns(provider).catch(() => ({ turns: [] }))
    ]);
    setApprovals((approvalData.approvals || []).filter((item) => item.status === 'pending').reverse().slice(0, 6));
    setJobs((jobData.jobs || []).slice(0, 6));
    setTurns((turnData.turns || []).slice(0, 6));
  }

  async function refreshAll() {
    await refreshSnapshot();
    await refreshSidePanels();
  }

  async function pickAndUpload() {
    const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
    const upload = await client.upload(provider, asset.name || 'upload.bin', base64);
    await client.send(provider, `已上传文件，请使用这个目标机器本地路径作为附件/参考：${upload.path}`).catch(() => {});
    await notifyLocal('TriCLI 上传完成', upload.path);
    await refreshAll();
  }

  const selectedProvider = providers.find((item) => item.id === provider)!;

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>TriCLI Remote</Text>
          <Text style={styles.title}>手机远程控制三种 AI CLI</Text>
          <Text style={styles.subtitle}>React Native 原生控制台：Codex、Claude Code、Cursor Agent。断开 App 后，目标机器 daemon / tmux 继续运行。</Text>
          <View style={styles.heroRow}>
            <StatusPill text={machineId ? 'Relay' : 'Direct'} tone="ok" />
            <StatusPill text={selectedProvider.label} />
            <StatusPill text={status} tone={status === 'attention' ? 'warn' : status === 'idle' ? 'muted' : 'ok'} />
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>连接电脑 / 服务器</Text>
          <Text style={styles.help}>填公网 relay 地址后可加载机器；填 daemon 地址则清空 machineId 直连。</Text>
          <Text style={styles.label}>Server / Daemon URL</Text>
          <TextInput value={controlUrl} onChangeText={setControlUrl} style={styles.input} placeholderTextColor={theme.colors.textMuted} autoCapitalize="none" />
          <Text style={styles.label}>访问令牌（可选）</Text>
          <TextInput value={token} onChangeText={setToken} style={styles.input} placeholder="TRICLI_TOKEN" placeholderTextColor={theme.colors.textMuted} secureTextEntry autoCapitalize="none" />
          <View style={styles.rowWrap}>
            <Pressable style={styles.secondary} onPress={() => run(async () => { const data = await serverClient.listMachines(); setMachines(data.machines || []); })}>
              <Text style={styles.secondaryText}>加载机器</Text>
            </Pressable>
            <Pressable style={styles.secondary} onPress={() => { setMachineId(''); setMachines([]); }}>
              <Text style={styles.secondaryText}>作为直连 daemon</Text>
            </Pressable>
          </View>
          {machineId ? <Text style={styles.selected}>当前机器：{machineId}</Text> : <Text style={styles.selected}>当前：直连 {effectiveBaseUrl}</Text>}
          {machines.map((machine) => (
            <Pressable key={machine.machineId} style={[styles.machine, machineId === machine.machineId && styles.machineActive]} onPress={() => setMachineId(machine.machineId)}>
              <Text style={styles.machineTitle}>{machine.name || machine.machineId}</Text>
              <Text style={styles.machineSub}>{machine.machineId} · {machine.transport || 'unknown'} · {machine.lastSeenAt || ''}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>CLI 平台</Text>
          <View style={styles.tabs}>{providers.map((item) => (
            <Pressable key={item.id} onPress={() => { setProvider(item.id); setStatus('idle'); }} style={[styles.tab, provider === item.id && { borderColor: item.color }]}> 
              <Text style={[styles.tabText, provider === item.id && { color: item.color }]}>{item.label}</Text>
            </Pressable>
          ))}</View>
          <Text style={styles.label}>工作目录</Text>
          <TextInput value={cwd} onChangeText={setCwd} style={styles.input} placeholderTextColor={theme.colors.textMuted} autoCapitalize="none" />
          <View style={styles.rowWrap}>
            <Pressable style={styles.primary} disabled={busy} onPress={() => run(async () => { await client.startSession(provider, cwd); await notifyLocal('TriCLI 正在运行', `${provider} 会话已启动，断开 App 后仍会继续。`); await refreshAll(); })}>
              <Text style={styles.primaryText}>启动/接管</Text>
            </Pressable>
            <Pressable style={styles.danger} disabled={busy} onPress={() => run(async () => { await client.stopSession(provider); setStatus('idle'); await refreshAll(); })}>
              <Text style={styles.dangerText}>停止</Text>
            </Pressable>
            <Pressable style={styles.secondary} disabled={busy} onPress={() => run(refreshAll)}>
              <Text style={styles.secondaryText}>同步</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>终端同步</Text>
            <StatusPill text={busy ? 'working' : status} tone={status === 'attention' ? 'warn' : status === 'idle' ? 'muted' : 'ok'} />
          </View>
          <Text selectable style={styles.terminal}>{terminal}</Text>
          <TextInput value={prompt} onChangeText={setPrompt} multiline style={[styles.input, styles.prompt]} placeholder="输入指令，例如：继续并汇报进度" placeholderTextColor={theme.colors.textMuted} />
          <View style={styles.rowWrap}>
            <Pressable style={styles.primary} disabled={busy || !prompt.trim()} onPress={() => run(async () => { await client.send(provider, prompt); await notifyLocal('TriCLI 已发送', `${provider} 正在处理。`); setPrompt(''); await refreshAll(); })}>
              <Text style={styles.primaryText}>发送</Text>
            </Pressable>
            {['C-c', 'Escape', 'Enter'].map((key) => (
              <Pressable key={key} style={styles.secondarySmall} onPress={() => run(async () => { await client.keys(provider, [key]); await refreshAll(); })}>
                <Text style={styles.secondaryText}>{key}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>上传图片 / 文件</Text>
          <Text style={styles.help}>文件保存到目标机器 daemon 附件目录，并把路径发送给当前 CLI。</Text>
          <Pressable style={styles.secondary} onPress={() => run(pickAndUpload)}>
            <Text style={styles.secondaryText}>选择并上传文件</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>审批中心</Text>
          {approvals.length === 0 ? <Text style={styles.empty}>暂无待审批/待选择项</Text> : approvals.map((item) => (
            <View key={item.id} style={styles.panelItem}>
              <Text style={styles.itemTitle}>{item.title || 'Needs approval'}</Text>
              <Text style={styles.itemSub}>{item.message}</Text>
              <View style={styles.rowWrap}>
                <Pressable style={styles.primarySmall} onPress={() => run(async () => { await client.respondApproval(item.id, { decision: 'approve' }); await refreshAll(); })}><Text style={styles.primaryText}>允许</Text></Pressable>
                <Pressable style={styles.dangerSmall} onPress={() => run(async () => { await client.respondApproval(item.id, { decision: 'deny' }); await refreshAll(); })}><Text style={styles.dangerText}>拒绝</Text></Pressable>
                <Pressable style={styles.secondarySmall} onPress={() => run(async () => { await client.respondApproval(item.id, { keys: ['Enter'], decision: 'enter' }); await refreshAll(); })}><Text style={styles.secondaryText}>Enter</Text></Pressable>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>结构化 Turn</Text>
          <Text style={styles.help}>Codex app-server；Claude/Cursor stream-json。由 daemon 持续收集，App 可断开重连。</Text>
          <Pressable style={styles.secondary} disabled={busy || !prompt.trim()} onPress={() => run(async () => { await client.runStructuredTurn(provider, prompt, cwd); await refreshSidePanels(); })}>
            <Text style={styles.secondaryText}>用当前输入启动 structured turn</Text>
          </Pressable>
          {turns.length === 0 ? <Text style={styles.empty}>暂无 structured turn</Text> : turns.map((turn) => (
            <View key={turn.id} style={styles.panelItem}>
              <Text style={styles.itemTitle}>{turn.status} · {turn.promptPreview || turn.id}</Text>
              <Text style={styles.itemSub}>{turn.adapter} · events {turn.eventCount} · text {turn.textBytes}B</Text>
              {['starting', 'running'].includes(turn.status) ? <Pressable style={styles.dangerSmall} onPress={() => run(async () => { await client.killStructuredTurn(provider, turn.id); await refreshSidePanels(); })}><Text style={styles.dangerText}>停止 turn</Text></Pressable> : null}
            </View>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>CLI 子命令 Job</Text>
          <TextInput value={jobArgs} onChangeText={setJobArgs} style={styles.input} placeholder="--help 或 mcp list" placeholderTextColor={theme.colors.textMuted} autoCapitalize="none" />
          <Pressable style={styles.secondary} onPress={() => run(async () => { await client.runJob(provider, splitArgs(jobArgs || '--help'), cwd); await refreshSidePanels(); })}>
            <Text style={styles.secondaryText}>启动 CLI Job</Text>
          </Pressable>
          {jobs.length === 0 ? <Text style={styles.empty}>暂无 CLI job</Text> : jobs.map((job) => (
            <View key={job.id} style={styles.panelItem}>
              <Text style={styles.itemTitle}>{job.status} · {job.command} {job.args?.join(' ')}</Text>
              <Text style={styles.itemSub}>{job.id} · stdout {job.stdoutBytes}B · stderr {job.stderrBytes}B</Text>
              {['starting', 'running'].includes(job.status) ? <Pressable style={styles.dangerSmall} onPress={() => run(async () => { await client.killJob(job.id); await refreshSidePanels(); })}><Text style={styles.dangerText}>停止 job</Text></Pressable> : null}
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const controlBase = {
  minHeight: 48,
  borderRadius: theme.radius.control,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  paddingHorizontal: 16,
  borderWidth: 1
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.bg },
  content: { padding: 16, gap: 16, paddingBottom: 40 },
  hero: { padding: 20, borderRadius: theme.radius.card, backgroundColor: theme.colors.bgDeep, borderWidth: 1, borderColor: theme.colors.border, gap: 10 },
  eyebrow: { color: theme.colors.green, letterSpacing: 2, fontSize: 12, fontWeight: '800' },
  title: { color: theme.colors.text, fontSize: 34, lineHeight: 38, letterSpacing: -1.5, fontWeight: '900' },
  subtitle: { color: theme.colors.textMuted, lineHeight: 22 },
  heroRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  card: { padding: 16, borderRadius: theme.radius.card, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, gap: 12 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  cardTitle: { color: theme.colors.text, fontSize: 18, fontWeight: '800' },
  help: { color: theme.colors.textMuted, lineHeight: 20, fontSize: 13 },
  label: { color: theme.colors.textMuted, fontSize: 12, marginTop: 4 },
  selected: { color: theme.colors.textMuted, fontSize: 12 },
  input: { minHeight: 48, borderRadius: theme.radius.control, backgroundColor: theme.colors.bgDeep, color: theme.colors.text, paddingHorizontal: 14, borderWidth: 1, borderColor: theme.colors.border },
  prompt: { minHeight: 96, textAlignVertical: 'top', paddingTop: 12 },
  tabs: { flexDirection: 'row', gap: 8 },
  tab: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.control, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.bgDeep },
  tabText: { color: theme.colors.textMuted, fontWeight: '800' },
  rowWrap: { flexDirection: 'row', gap: 10, flexWrap: 'wrap', alignItems: 'center' },
  primary: { ...controlBase, backgroundColor: theme.colors.green, borderColor: theme.colors.green },
  primarySmall: { ...controlBase, minHeight: 40, backgroundColor: theme.colors.green, borderColor: theme.colors.green },
  primaryText: { color: '#04130A', fontWeight: '900' },
  secondary: { ...controlBase, backgroundColor: theme.colors.surfaceSoft, borderColor: theme.colors.border },
  secondarySmall: { ...controlBase, minHeight: 40, backgroundColor: theme.colors.surfaceSoft, borderColor: theme.colors.border },
  secondaryText: { color: theme.colors.text, fontWeight: '800' },
  danger: { ...controlBase, backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.45)' },
  dangerSmall: { ...controlBase, minHeight: 40, backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.45)' },
  dangerText: { color: '#FECACA', fontWeight: '900' },
  machine: { padding: 12, borderRadius: 16, backgroundColor: theme.colors.bgDeep, borderWidth: 1, borderColor: theme.colors.border, gap: 4 },
  machineActive: { borderColor: theme.colors.green },
  machineTitle: { color: theme.colors.text, fontWeight: '800' },
  machineSub: { color: theme.colors.textMuted, fontSize: 12 },
  terminal: { minHeight: 320, color: '#E5E7EB', backgroundColor: theme.colors.bgDeep, borderRadius: 18, borderWidth: 1, borderColor: theme.colors.border, padding: 12, fontFamily: 'monospace', lineHeight: 20 },
  panelItem: { padding: 12, borderRadius: 16, backgroundColor: theme.colors.bgDeep, borderWidth: 1, borderColor: theme.colors.border, gap: 8 },
  itemTitle: { color: theme.colors.text, fontWeight: '800' },
  itemSub: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 18 },
  empty: { color: theme.colors.textMuted, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 14, padding: 10, backgroundColor: theme.colors.bgDeep },
  pill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, overflow: 'hidden', borderWidth: 1, fontSize: 12, fontWeight: '800' },
  pill_muted: { color: theme.colors.textMuted, borderColor: theme.colors.border, backgroundColor: 'rgba(148,163,184,0.08)' },
  pill_ok: { color: '#BBF7D0', borderColor: 'rgba(34,197,94,0.45)', backgroundColor: 'rgba(34,197,94,0.10)' },
  pill_warn: { color: '#FDE68A', borderColor: 'rgba(245,158,11,0.45)', backgroundColor: 'rgba(245,158,11,0.10)' },
  pill_danger: { color: '#FECACA', borderColor: 'rgba(239,68,68,0.45)', backgroundColor: 'rgba(239,68,68,0.10)' }
});
