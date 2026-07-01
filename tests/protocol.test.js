import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, assertProvider, sanitizeFilename } from '../packages/core/protocol.js';

test('providers include codex claude cursor and work command mapping', () => {
  assert.deepEqual(PROVIDERS.map((provider) => provider.id), ['codex', 'claude', 'cursor']);
  assert.equal(PROVIDERS.find((provider) => provider.id === 'codex').workCommand, 'codex-work');
  assert.equal(PROVIDERS.find((provider) => provider.id === 'claude').tmuxSession, 'ai-claude');
  assert.equal(PROVIDERS.find((provider) => provider.id === 'cursor').fallback.includes('ai-work'), true);
});

test('assertProvider rejects unknown providers', () => {
  assert.equal(assertProvider('codex'), 'codex');
  assert.throws(() => assertProvider('gemini'), /Unknown provider/);
});

test('sanitizeFilename strips path and unsafe characters', () => {
  assert.equal(sanitizeFilename('../../secret?.png'), 'secret_.png');
  assert.equal(sanitizeFilename(''), 'upload.bin');
});
