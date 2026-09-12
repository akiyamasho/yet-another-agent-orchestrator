'use strict';

// A newly-created thread may only be removed from the pending overlay once
// Codex confirms the archive mutation succeeded.
async function archiveThreadAndForget({ threadId, archiveThread, pendingThreads }) {
  const result = await archiveThread(String(threadId));
  pendingThreads.remove(threadId);
  return result;
}

module.exports = { archiveThreadAndForget };
