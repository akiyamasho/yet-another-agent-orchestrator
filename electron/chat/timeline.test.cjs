'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCodexTimeline, normalizeClaudeTimeline } = require('./timeline.cjs');

test('Codex timeline preserves chronological messages, tools, files, and running state', () => {
  const result = normalizeCodexTimeline({ thread: { id: 'codex-demo', status: { type: 'active', activeFlags: [] }, turns: [{ id: 'turn-1', status: 'inProgress', startedAt: 1_700_000_000, items: [
    { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Review the dashboard' }] },
    { id: 'a1', type: 'agentMessage', text: 'I am checking it now.', phase: 'commentary' },
    { id: 'c1', type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 },
    { id: 'f1', type: 'fileChange', status: 'inProgress', changes: [{ path: '/demo/app.tsx', kind: 'update', diff: '+fixed' }] },
  ] }] } });
  assert.equal(result.status, 'running');
  assert.deepEqual(result.items.map((item) => item.kind), ['message', 'message', 'tool', 'file']);
  assert.equal(result.items[0].role, 'user');
  assert.equal(result.items[3].changes[0].path, '/demo/app.tsx');
});

test('Codex waiting flags override active state', () => {
  const result = normalizeCodexTimeline({ thread: { id: 'codex-demo', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, turns: [] } });
  assert.equal(result.status, 'needs_attention');
});

test('Codex recently changing in another client is labeled as inferred running', () => {
  const result = normalizeCodexTimeline({ thread: { id: 'codex-external', status: { type: 'notLoaded' }, updatedAt: Date.now(), turns: [{ id: 'done', status: 'completed', items: [] }] } });
  assert.equal(result.status, 'running');
  assert.equal(result.externalRuntime, true);
  assert.equal(result.inferredRuntime, true);
});

test('Claude timeline links tool use and result and preserves file changes', () => {
  const result = normalizeClaudeTimeline({ id: 'claude-demo', runtimeStatus: 'running', records: [
    { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { content: 'Update the file' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { content: [
      { type: 'text', text: 'I will update it.' },
      { type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: '/demo/app.tsx', old_string: 'a', new_string: 'b' } },
    ] } },
    { type: 'user', uuid: 'u2', timestamp: '2026-01-01T00:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Updated' }] } },
  ] });
  assert.equal(result.status, 'running');
  assert.equal(result.items.filter((item) => item.kind === 'tool').length, 1);
  assert.equal(result.items.find((item) => item.kind === 'tool').status, 'completed');
  assert.equal(result.items.find((item) => item.kind === 'file').changes[0].path, '/demo/app.tsx');
});

test('Claude terminal errors set failed state and remain visible', () => {
  const result = normalizeClaudeTimeline({ id: 'claude-demo', runtimeStatus: 'failed', records: [{ type: 'result', subtype: 'error_during_execution', is_error: true, error: 'Command failed' }] });
  assert.equal(result.status, 'failed');
  assert.equal(result.items[0].status, 'failed');
});
