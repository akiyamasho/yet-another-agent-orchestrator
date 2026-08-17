'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { ClaudeCodeProvider, extractFiles } = require('./provider.cjs');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'constellation-claude-'));
  const projects = path.join(root, '.claude', 'projects', '-tmp-demo');
  await fs.mkdir(projects, { recursive: true });
  const records = [
    { type: 'user', uuid: 'u1', timestamp: '2026-08-01T10:00:00.000Z', sessionId: 'sess-1', cwd: '/tmp/demo', message: { role: 'user', content: [{ type: 'text', text: 'Review /tmp/demo/assets/hero.png' }] } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-08-01T10:00:01.000Z', sessionId: 'sess-1', cwd: '/tmp/demo', message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'I will inspect the image.' }] } },
    { type: 'result', timestamp: '2026-08-01T10:00:02.000Z', sessionId: 'sess-1', cwd: '/tmp/demo' },
  ];
  await fs.writeFile(path.join(projects, 'sess-1.jsonl'), records.map(JSON.stringify).join('\n'));
  return { root, projects };
}

test('discovers project/session metadata from Claude JSONL history', async () => {
  const { root } = await fixture();
  const provider = new ClaudeCodeProvider({ home: root });
  const projects = await provider.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].cwd, '/tmp/demo');
  assert.equal(projects[0].sessions[0].id, 'sess-1');
  assert.equal(projects[0].sessions[0].model, 'claude-sonnet-4');
  assert.equal(projects[0].sessions[0].status, 'completed');
  assert.equal(projects[0].sessions[0].title, 'Review /tmp/demo/assets/hero.png');
  await fs.rm(root, { recursive: true, force: true });
});

test('reads full transcript and returns file/image references', async () => {
  const { root } = await fixture();
  const provider = new ClaudeCodeProvider({ home: root });
  const transcript = await provider.readSession('sess-1');
  assert.equal(transcript.messages.length, 2);
  assert.equal(transcript.files[0].kind, 'image');
  assert.equal(transcript.files[0].path, '/tmp/demo/assets/hero.png');
  assert.equal(extractFiles([{ message: { content: 'Open ~/notes.md' } }])[0].path, path.join(os.homedir(), 'notes.md'));
  await fs.rm(root, { recursive: true, force: true });
});

test('starts a persistent named stream and emits parsed events', async () => {
  let spawned;
  function fakeSpawn(command, args, options) {
    spawned = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 0, null);
    process.nextTick(() => child.stdout.write('{"type":"system","session_id":"new-1"}\n'));
    return child;
  }
  const provider = new ClaudeCodeProvider({ spawn: fakeSpawn });
  const handle = provider.startSession({ cwd: '/tmp/demo', prompt: 'Do the task', name: 'Demo task', model: 'sonnet' });
  const event = await new Promise((resolve) => handle.once('event', resolve));
  assert.equal(spawned.command, 'claude');
  assert.deepEqual(spawned.args.slice(0, 7), ['-p', 'Do the task', '--output-format', 'stream-json', '--verbose', '--name', 'Demo task']);
  assert.equal(event.session_id, 'new-1');
  assert.equal(handle.sessionId, 'new-1');
  assert.equal(provider.runtimeStatuses.get('new-1'), 'running');
  assert.equal(provider.liveRecords.get('new-1').length, 1);
});

test('interrupts an owned Claude session without marking it failed or taking the provider offline', async () => {
  let signal;
  function fakeSpawn() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (requestedSignal) => {
      signal = requestedSignal;
      process.nextTick(() => child.emit('close', null, requestedSignal));
    };
    process.nextTick(() => child.stdout.write('{"type":"system","session_id":"cancel-1"}\n'));
    return child;
  }
  const provider = new ClaudeCodeProvider({ spawn: fakeSpawn });
  const handle = provider.startSession({ cwd: '/tmp/demo', prompt: 'Long task' });
  await new Promise((resolve) => handle.once('event', resolve));
  const exit = new Promise((resolve) => handle.once('exit', resolve));
  const result = await provider.interruptSession('cancel-1', { timeoutMs: 100, killTimeoutMs: 100 });
  assert.equal(result.interrupted, true);
  assert.equal(signal, 'SIGINT');
  assert.equal((await exit).interrupted, true);
  assert.equal(provider.runtimeStatuses.get('cancel-1'), 'interrupted');
  assert.equal(provider.children.has('cancel-1'), false);
});

test('refuses to signal an active Claude session without an owned child handle', async () => {
  const provider = new ClaudeCodeProvider();
  provider.runtimeStatuses.set('external-1', 'running');
  await assert.rejects(() => provider.interruptSession('external-1'), /refusing to signal an external process/);
});

test('resumes the exact Claude session and forwards attachment directory grants', () => {
  let spawned;
  function fakeSpawn(command, args, options) {
    spawned = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
  }
  const provider = new ClaudeCodeProvider({ spawn: fakeSpawn });
  provider.resumeSession('session-existing', 'Review @/tmp/reference/board.png', {
    cwd: '/tmp/demo',
    extraArgs: ['--add-dir', '/tmp/reference'],
  });
  assert.ok(spawned.args.includes('--resume'));
  assert.equal(spawned.args[spawned.args.indexOf('--resume') + 1], 'session-existing');
  assert.deepEqual(spawned.args.slice(-2), ['--add-dir', '/tmp/reference']);
});

test('deletes a Claude session and all recursively mapped descendants from temporary history', async () => {
  const { root, projects } = await fixture();
  await fs.writeFile(path.join(projects, 'child.jsonl'), JSON.stringify({ type: 'user', uuid: 'cu1', timestamp: '2026-08-01T10:01:00.000Z', sessionId: 'child', parentSessionId: 'sess-1', cwd: '/tmp/demo', message: { role: 'user', content: 'child' } }));
  await fs.writeFile(path.join(projects, 'grandchild.jsonl'), JSON.stringify({ type: 'user', uuid: 'gu1', timestamp: '2026-08-01T10:02:00.000Z', sessionId: 'grandchild', parentSessionId: 'child', cwd: '/tmp/demo', message: { role: 'user', content: 'grandchild' } }));
  const provider = new ClaudeCodeProvider({ home: root });
  const result = await provider.deleteSession('sess-1');
  assert.deepEqual(new Set(result.deletedSessionIds), new Set(['sess-1', 'child', 'grandchild']));
  assert.equal(result.deletedPathsCount, 3);
  assert.equal(await fs.stat(path.join(projects, 'sess-1.jsonl')).catch(() => null), null);
  assert.equal(await fs.stat(path.join(projects, 'child.jsonl')).catch(() => null), null);
  assert.equal(await fs.stat(path.join(projects, 'grandchild.jsonl')).catch(() => null), null);
  await fs.rm(root, { recursive: true, force: true });
});

test('deletes only the selected Claude leaf and is idempotent for an already removed transcript', async () => {
  const { root, projects } = await fixture();
  await fs.writeFile(path.join(projects, 'leaf.jsonl'), JSON.stringify({ type: 'user', uuid: 'lu1', timestamp: '2026-08-01T10:01:00.000Z', sessionId: 'leaf', parentSessionId: 'sess-1', cwd: '/tmp/demo', message: { role: 'user', content: 'leaf' } }));
  const provider = new ClaudeCodeProvider({ home: root });
  const first = await provider.deleteSession('leaf');
  assert.deepEqual(first.deletedSessionIds, ['leaf']);
  assert.equal(first.deletedPathsCount, 1);
  await assert.rejects(() => provider.deleteSession('leaf'), /session not found/);
  await fs.rm(root, { recursive: true, force: true });
});

test('refuses to delete a running Claude session', async () => {
  const { root } = await fixture();
  const provider = new ClaudeCodeProvider({ home: root });
  provider.runtimeStatuses.set('sess-1', 'running');
  await assert.rejects(() => provider.deleteSession('sess-1'), /Stop Claude session sess-1 before deleting it/);
  assert.ok(await fs.stat(path.join(root, '.claude', 'projects', '-tmp-demo', 'sess-1.jsonl')));
  await fs.rm(root, { recursive: true, force: true });
});

test('refuses a transcript outside the canonical Claude projects directory', async () => {
  const { root, projects } = await fixture();
  const outside = path.join(root, 'outside.jsonl');
  await fs.writeFile(outside, JSON.stringify({ type: 'user', sessionId: 'outside', message: { role: 'user', content: 'outside' } }));
  const provider = new ClaudeCodeProvider({ home: root });
  provider.listSessions = async () => [{ id: 'outside', transcriptPath: outside, parentSessionId: null, status: 'idle' }];
  await assert.rejects(() => provider.deleteSession('outside'), /outside the canonical projects directory/);
  assert.ok(await fs.stat(outside));
  assert.ok(await fs.stat(path.join(projects, 'sess-1.jsonl')));
  await fs.rm(root, { recursive: true, force: true });
});

test('keeps Claude archive unsupported while exposing guarded destructive deletion', async () => {
  const provider = new ClaudeCodeProvider();
  assert.equal(provider.capabilities.archive, false);
  assert.equal(provider.capabilities.delete, true);
  assert.equal(provider.capabilities.historyDestructiveDelete, true);
  await assert.rejects(() => provider.archiveSession('x'), /no supported archive API/);
});
