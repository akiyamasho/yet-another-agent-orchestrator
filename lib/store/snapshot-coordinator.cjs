'use strict';

/**
 * Coalesces refresh requests without allowing a refresh requested during an
 * active snapshot to be lost. The task installed for the next pass is always
 * the most recently requested task.
 */
function createSnapshotCoordinator() {
  let inFlight = null;
  let rerun = false;
  let latestTask;

  return {
    run(snapshotTask) {
      if (typeof snapshotTask !== 'function') return Promise.reject(new TypeError('snapshotTask must be a function'));
      latestTask = snapshotTask;
      if (inFlight) {
        rerun = true;
        return inFlight;
      }
      inFlight = (async () => {
        do {
          rerun = false;
          const task = latestTask;
          await task();
        } while (rerun);
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

module.exports = { createSnapshotCoordinator };
