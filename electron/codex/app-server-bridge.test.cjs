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
