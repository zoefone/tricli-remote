import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSnapshot, approvalResponseToKeys, mergeDetectedApprovals } from '../packages/core/adapters.js';

test('analyzeSnapshot detects approval-like terminal output', () => {
  const analysis = analyzeSnapshot('codex', 'Running command\nApprove running this command? y/N');
  assert.equal(analysis.provider, 'codex');
  assert.equal(analysis.approvals.length >= 1, true);
  assert.equal(analysis.structuredMarkers.hasCommand, true);
});

test('mergeDetectedApprovals deduplicates pending approval fingerprints', () => {
  const detected = analyzeSnapshot('claude', 'permission required: allow Edit tool?').approvals;
  const once = mergeDetectedApprovals([], detected, { machineId: 'm1' });
  const twice = mergeDetectedApprovals(once, detected, { machineId: 'm1' });
  assert.equal(once.length, 1);
  assert.equal(twice.length, 1);
  assert.equal(twice[0].machineId, 'm1');
});

test('approvalResponseToKeys maps common approve and deny decisions', () => {
  assert.deepEqual(approvalResponseToKeys({ decision: 'approve' }), ['y', 'Enter']);
  assert.deepEqual(approvalResponseToKeys({ decision: 'deny' }), ['n', 'Enter']);
  assert.deepEqual(approvalResponseToKeys({ keys: ['1', 'Enter'] }), ['1', 'Enter']);
});
