'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { CodexAppServerBridge } = require('./app-server-bridge.cjs');

function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => child.emit('close', 0, null);
  child.stdin.on('data', (chunk) => {
    const message = JSON.parse(String(chunk));
    if (message.method === 'initialize') child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 2 } }) + '\n');
    if (message.method === 'thread/list') child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { data: [{ id: message.params.archived ? 'archived' : 'active' }], nextCursor: null } }) + '\n');
    if (message.method === 'turn/start') child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-1' }, received: message.params } }) + '\n');
    if (message.method === 'turn/steer') child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { turnId: message.params.expectedTurnId, received: message.params } }) + '\n');
    if (message.method === 'turn/interrupt') child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { interrupted: true, received: message.params } }) + '\n');
    if (message.method === 'thread/name/set') child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { received: message.params } }) + '\n');
  });
  return child;
}

test('initializes and lists active plus archived threads across all source kinds', async () => {
  const bridge = new CodexAppServerBridge({ spawn: () => fakeSpawn(), requestTimeoutMs: 500 });
  await bridge.connect();
  const threads = await bridge.listThreads();
  assert.deepEqual(threads.map((t) => t.id), ['active', 'archived']);
  bridge.close();
});

test('emits JSON-RPC notifications', async () => {
  const bridge = new CodexAppServerBridge({ spawn: () => fakeSpawn(), requestTimeoutMs: 500 });
  await bridge.connect();
  const notification = new Promise((resolve) => bridge.once('thread/started', resolve));
  bridge._child.stdout.write(JSON.stringify({ method: 'thread/started', params: { thread: { id: 't1' } } }) + '\n');
  assert.deepEqual(await notification, { thread: { id: 't1' } });
  bridge.close();
});

test('starts and steers turns with provider-native attachment inputs', async () => {
  const bridge = new CodexAppServerBridge({ spawn: () => fakeSpawn(), requestTimeoutMs: 500 });
  await bridge.connect();
  const input = [
    { type: 'text', text: 'Review this screenshot' },
    { type: 'localImage', path: '/tmp/design.png' },
  ];
  const started = await bridge.startTurn('thread-1', input);
  assert.deepEqual(started.received.input, input);
  assert.equal(bridge.getActiveTurnId('thread-1'), 'turn-1');
  const steered = await bridge.steerTurn('thread-1', 'turn-1', input);
  assert.equal(steered.turnId, 'turn-1');
  assert.deepEqual(steered.received.input, input);
  bridge.close();
});

test('interrupts a concrete active turn through the official turn/interrupt method', async () => {
  const bridge = new CodexAppServerBridge({ spawn: () => fakeSpawn(), requestTimeoutMs: 500 });
  await bridge.connect();
  bridge._child.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } }) + '\n');
  assert.equal(bridge.getActiveTurnId('thread-1'), 'turn-1');
  const result = await bridge.interruptTurn('thread-1', bridge.getActiveTurnId('thread-1'));
  assert.equal(result.interrupted, true);
  assert.deepEqual(result.received, { threadId: 'thread-1', turnId: 'turn-1' });
  assert.equal(bridge.getActiveTurnId('thread-1'), null);
  bridge.close();
});

test('clears locally owned active turns when the app-server exits', async () => {
  const bridge = new CodexAppServerBridge({ spawn: () => fakeSpawn(), requestTimeoutMs: 500 });
  await bridge.connect();
  await bridge.startTurn('thread-1', 'Keep working');
  assert.equal(bridge.getActiveTurnId('thread-1'), 'turn-1');
  bridge._child.emit('close', 0, null);
  assert.equal(bridge.getActiveTurnId('thread-1'), null);
  bridge.close();
});

test('renames a task with the current app-server thread/name/set method', async () => {
  const bridge = new CodexAppServerBridge({ spawn: () => fakeSpawn(), requestTimeoutMs: 500 });
  await bridge.connect();
  const renamed = await bridge.setThreadName('thread-1', 'Release audit');
  assert.deepEqual(renamed.received, { threadId: 'thread-1', name: 'Release audit' });
  bridge.close();
});
