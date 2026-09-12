'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { PendingCreatedThreads } = require('./pending-created-threads.cjs');

test('overlays omitted creations, dedupes when inventory catches up, and removes on expiry', () => {
  let now = 1000;
  const pending = new PendingCreatedThreads({ ttlMs: 50, now: () => now });
  pending.remember({ id: 'new', cwd: '/synthetic/project' });
  assert.deepEqual(pending.overlay([{ id: 'other' }]).map((item) => item.id), ['other', 'new']);
  assert.deepEqual(pending.overlay([{ id: 'new', cwd: '/synthetic/project', name: 'enriched' }]), [{ id: 'new', cwd: '/synthetic/project', name: 'enriched' }]);
  assert.equal(pending.size(), 0);
  pending.remember({ id: 'deleted' });
  pending.remove('deleted');
  assert.deepEqual(pending.overlay([]), []);
  pending.remember({ id: 'expired' });
  now += 51;
  assert.deepEqual(pending.overlay([]), []);
  assert.equal(pending.size(), 0);
});

test('does not inject archived pending records into an active-only overlay', () => {
  const pending = new PendingCreatedThreads();
  pending.remember({ id: 'archived-pending', archived: true });
  assert.deepEqual(pending.overlay([], { includePending: (thread) => !thread.archived }), []);
  assert.equal(pending.size(), 1);
  assert.deepEqual(pending.overlay([]), [{ id: 'archived-pending', archived: true }]);
});

test('keeps the exact returned record and replaces it only with normal inventory', () => {
  const pending = new PendingCreatedThreads();
  const exact = { id: 'same', cwd: '/synthetic/project', source: { kind: 'subAgentOther' } };
  pending.remember(exact);
  assert.deepEqual(pending.overlay([]), [exact]);
  pending.remember(exact);
  assert.equal(pending.overlay([]).length, 1);
});
