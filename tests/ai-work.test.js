import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

test('ai-work exposes non-interactive remote-control commands', () => {
  const help = execFileSync('ai-work', ['--help'], { encoding: 'utf8' });
  assert.match(help, /ensure PROVIDER/);
  assert.match(help, /capture PROVIDER/);
  assert.match(help, /send PROVIDER/);
  assert.match(help, /codex-work/);
});

test('repo ships reusable ai-work installer and provider wrappers', () => {
  const sourceHelp = execFileSync('bash', ['scripts/ai-work', '--help'], { encoding: 'utf8' });
  assert.match(sourceHelp, /ensure PROVIDER/);
  assert.match(sourceHelp, /cursor-work/);
  const installer = readFileSync('scripts/install-work-commands.sh', 'utf8');
  assert.match(installer, /codex-work/);
  assert.match(installer, /claude-work/);
  assert.match(installer, /cursor-work/);
  assert.equal(Boolean(statSync('scripts/install-work-commands.sh').mode & 0o111), true);
  assert.match(readFileSync('scripts/install-systemd.sh', 'utf8'), /install-work-commands\.sh/);
});

test('installed provider shortcuts delegate to ai-work sessions', () => {
  assert.match(readFileSync('/usr/local/bin/codex-work', 'utf8'), /exec ai-work codex/);
  assert.match(readFileSync('/usr/local/bin/claude-work', 'utf8'), /exec ai-work claude/);
  assert.match(readFileSync('/usr/local/bin/cursor-work', 'utf8'), /exec ai-work cursor/);
});

test('ai-work list-json returns JSON array', () => {
  const out = execFileSync('ai-work', ['list-json'], { encoding: 'utf8' });
  assert.ok(Array.isArray(JSON.parse(out)));
});
