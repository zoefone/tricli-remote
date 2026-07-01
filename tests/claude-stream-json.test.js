import test from 'node:test';
import assert from 'node:assert/strict';
import { mapClaudeStreamJsonMessage, summarizeClaudeEvents, ClaudeStreamJsonClient } from '../packages/core/claude-stream-json.js';

test('maps Claude assistant stream-json text', () => {
  const event = mapClaudeStreamJsonMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
  assert.equal(event.type, 'claude-assistant');
  assert.equal(event.provider, 'claude');
  assert.equal(event.adapter, 'claude-stream-json');
  assert.equal(event.text, 'hello');
});

test('maps Claude tool_use stream-json blocks', () => {
  const event = mapClaudeStreamJsonMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } }] } });
  assert.equal(event.type, 'claude-tool-use');
  assert.equal(event.toolUses.length, 1);
  assert.equal(event.toolUses[0].name, 'Bash');
});

test('summarizes Claude stream-json events', () => {
  const summary = summarizeClaudeEvents([
    { type: 'claude-assistant', text: 'hi' },
    { type: 'claude-thinking', text: 'think' },
    { type: 'claude-result', result: 'done' },
    { type: 'claude-tool-use', text: '', toolUses: [{ name: 'Read' }] }
  ]);
  assert.equal(summary.text, 'hi');
  assert.equal(summary.reasoning, 'think');
  assert.equal(summary.result, 'done');
  assert.equal(summary.tools.length, 1);
});

test('ClaudeStreamJsonClient builds non-interactive stream-json args', () => {
  const client = new ClaudeStreamJsonClient({ model: 'sonnet', permissionMode: 'plan', extraArgs: ['--verbose'] });
  const args = client.buildArgs('hello');
  assert.deepEqual(args.slice(0, 5), ['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages']);
  assert.equal(args.includes('--model'), true);
  assert.equal(args.includes('--permission-mode'), true);
  assert.equal(args.at(-1), 'hello');
});
