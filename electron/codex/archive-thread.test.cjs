'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { PendingCreatedThreads } = require('./pending-created-threads.cjs');
const { archiveThreadAndForget } = require('./archive-thread.cjs');

test('removes an omitted pending thread only after archive succeeds', async () => {
  const pendingThreads = new PendingCreatedThreads();
  pendingThreads.remember({ id: 'created', cwd: '/synthetic/project' });
  let archivedId;

  const result = await archiveThreadAndForget({
    threadId: 'created',
    archiveThread: async (threadId) => {
      archivedId = threadId;
      return { ok: true };
    },
    pendingThreads,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(archivedId, 'created');
  assert.deepEqual(pendingThreads.overlay([]), []);
});

test('keeps an omitted pending thread when archive fails', async () => {
  const pendingThreads = new PendingCreatedThreads();
  pendingThreads.remember({ id: 'created' });

  await assert.rejects(
    archiveThreadAndForget({
      threadId: 'created',
      archiveThread: async () => { throw new Error('archive failed'); },
      pendingThreads,
    }),
    /archive failed/,
  );

  assert.deepEqual(pendingThreads.overlay([]).map((thread) => thread.id), ['created']);
});
