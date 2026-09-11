const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Validate the deliberately narrow payload used by the manual recovery IPC routes.
 * Null-prototype records are accepted as plain records, but accessors and all
 * other prototypes are rejected so validation never executes attacker code.
 */
function validateRecoveryPayload(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Pi recovery payload must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Pi recovery payload must be a plain object.");
  }
  const keys = Reflect.ownKeys(payload);
  if (keys.length !== 1 || keys[0] !== "runId") {
    throw new Error("Pi recovery payload must contain only runId.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(payload, "runId");
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    throw new Error("Pi recovery runId must be a data property.");
  }
  const { value } = descriptor;
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || !RUN_ID_PATTERN.test(value)) {
    throw new Error("Malformed Pi run ID.");
  }
  return value;
}

function registerPiRecoveryIpc(ipcMain, getProvider) {
  const routes = [
    ["pi:retry-review", "retryReview"],
    ["pi:retry-integration", "retryIntegration"],
    ["pi:cleanup-run", "cleanupRun"],
  ];
  for (const [channel, method] of routes) {
    ipcMain.handle(channel, (_event, payload) => {
      const runId = validateRecoveryPayload(payload);
      return getProvider()[method](runId);
    });
  }
}

module.exports = { validateRecoveryPayload, registerPiRecoveryIpc };
