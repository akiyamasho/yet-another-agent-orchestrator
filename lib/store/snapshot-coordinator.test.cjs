'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSnapshotCoordinator } = require('./snapshot-coordinator.cjs');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('coalesces one request during a snapshot and waits for exactly one fresh pass', async () => {
  const gate = deferred();
  const calls = [];
  const coordinator = createSnapshotCoordinator();
  const first = coordinator.run(async () => { calls.push('first'); await gate.promise; });
  await Promise.resolve();
  const second = coordinator.run(async () => { calls.push('second'); });
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['first', 'second']);
});

test('uses the latest task for the coalesced pass', async () => {
  const gate = deferred();
  const values = [];
  const coordinator = createSnapshotCoordinator();
  const first = coordinator.run(async () => { values.push('old'); await gate.promise; });
  await Promise.resolve();
  const second = coordinator.run(async () => values.push('latest'));
  coordinator.run(async () => values.push('superseded'));
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(values, ['old', 'superseded']);
});
