import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function sh(command) {
  return execFileSync('bash', ['-lc', command], { encoding: 'utf8' });
}

test('ai-work can control a detached tmux session after client disconnect', async () => {
  const name = `tricli-test-${process.pid}`;
  const script = join(tmpdir(), `${name}.sh`);
  writeFileSync(script, '#!/usr/bin/env bash\necho READY\nwhile IFS= read -r line; do echo "ECHO:${line}"; done\n');
  chmodSync(script, 0o755);
  try {
    sh(`tmux kill-session -t ${name} 2>/dev/null || true`);
    sh(`tmux new-session -d -s ${name} ${script}`);
    const status = execFileSync('ai-work', ['status', name], { encoding: 'utf8' });
    assert.match(status, new RegExp(`running ${name}`));

    execFileSync('ai-work', ['send', name, 'hello-from-test'], { encoding: 'utf8' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const capture = execFileSync('ai-work', ['capture', name, '20'], { encoding: 'utf8' });
    assert.match(capture, /READY/);
    assert.match(capture, /ECHO:hello-from-test/);
  } finally {
    sh(`tmux kill-session -t ${name} 2>/dev/null || true`);
  }
});
