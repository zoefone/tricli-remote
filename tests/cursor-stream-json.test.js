import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCursorStreamJsonMessage, summarizeCursorEvents, CursorStreamJsonClient } from '../packages/core/cursor-stream-json.js';

test('maps Cursor assistant stream-json text', () => {
  const event = mapCursorStreamJsonMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
  assert.equal(event.type, 'cursor-assistant');
  assert.equal(event.provider, 'cursor');
  assert.equal(event.adapter, 'cursor-stream-json');
  assert.equal(event.text, 'hello');
});

test('maps Cursor tool_use stream-json blocks', () => {
  const event = mapCursorStreamJsonMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } }] } });
  assert.equal(event.type, 'cursor-tool-use');
  assert.equal(event.toolUses.length, 1);
  assert.equal(event.toolUses[0].name, 'Bash');
});

test('summarizes Cursor stream-json events and session id', () => {
  const summary = summarizeCursorEvents([
    { type: 'cursor-system', sessionId: 'chat-1' },
    { type: 'cursor-assistant', text: 'hi' },
    { type: 'cursor-thinking', text: 'think' },
    { type: 'cursor-result', result: 'done' },
    { type: 'cursor-tool-use', text: '', toolUses: [{ name: 'Read' }] }
  ]);
  assert.equal(summary.text, 'hi');
  assert.equal(summary.reasoning, 'think');
  assert.equal(summary.result, 'done');
  assert.equal(summary.tools.length, 1);
  assert.equal(summary.sessionId, 'chat-1');
});

test('CursorStreamJsonClient builds non-interactive stream-json args', () => {
  const client = new CursorStreamJsonClient({ model: 'gpt-5', mode: 'plan', resume: 'chat-1', force: true, cwd: '/tmp/work', extraArgs: ['--stream-partial-output'] });
  const args = client.buildArgs('hello');
  assert.deepEqual(args.slice(0, 3), ['-p', '--output-format', 'stream-json']);
  assert.equal(args.includes('--trust'), true);
  assert.equal(args.includes('--model'), true);
  assert.equal(args.includes('--mode'), true);
  assert.equal(args.includes('--resume'), true);
  assert.equal(args.includes('--force'), true);
  assert.equal(args.includes('--workspace'), true);
  assert.equal(args.includes('--stream-partial-output'), true);
  assert.equal(args.at(-1), 'hello');
});
