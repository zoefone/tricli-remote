import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCodexAppServerNotification, summarizeCodexEvents } from '../packages/core/codex-app-server.js';

test('maps Codex app-server deltas into TriCLI structured events', () => {
  const event = mapCodexAppServerNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr', turnId: 'turn', itemId: 'item', delta: 'hello' }
  });
  assert.equal(event.type, 'codex-agent-delta');
  assert.equal(event.provider, 'codex');
  assert.equal(event.adapter, 'codex-app-server');
  assert.equal(event.delta, 'hello');
});

test('summarizes Codex app-server text and command output streams', () => {
  const events = [
    { type: 'codex-agent-delta', delta: 'hi ' },
    { type: 'codex-plan-delta', delta: 'there' },
    { type: 'codex-command-output-delta', delta: 'stdout' },
    { type: 'codex-reasoning-delta', delta: 'thinking' },
    { type: 'codex-item-completed', item: { type: 'agentMessage', id: 'x' } }
  ];
  const summary = summarizeCodexEvents(events);
  assert.equal(summary.text, 'hi there');
  assert.equal(summary.commandOutput, 'stdout');
  assert.equal(summary.reasoning, 'thinking');
  assert.equal(summary.items.length, 1);
});

test('maps Codex app-server turn completion status', () => {
  const event = mapCodexAppServerNotification({
    method: 'turn/completed',
    params: { threadId: 'thr', turn: { id: 'turn', status: 'completed', error: null } }
  });
  assert.equal(event.type, 'codex-turn-completed');
  assert.equal(event.threadId, 'thr');
  assert.equal(event.turnId, 'turn');
  assert.equal(event.status, 'completed');
});
