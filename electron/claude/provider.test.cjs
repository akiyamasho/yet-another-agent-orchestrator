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

test('does not pretend Claude supports destructive session operations', async () => {
  const provider = new ClaudeCodeProvider();
  assert.equal(provider.capabilities.archive, false);
  await assert.rejects(() => provider.archiveSession('x'), /no supported archive API/);
  await assert.rejects(() => provider.deleteSession('x'), /deletion is intentionally disabled/);
});
