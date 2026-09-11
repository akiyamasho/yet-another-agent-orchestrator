const test = require("node:test");
const assert = require("node:assert/strict");
const { validateRecoveryPayload, registerPiRecoveryIpc } = require("./recovery-ipc.cjs");

const valid = "pi-project-123:review_run.v1";

test("recovery payload validator accepts only the exact runId record", () => {
  for (const payload of [{ runId: valid }, Object.assign(Object.create(null), { runId: valid })]) {
    assert.equal(validateRecoveryPayload(payload), valid);
  }

  const invalid = [
    valid, null, [], 1, undefined,
    { runId: "" }, { runId: "a b" }, { runId: "../secret" },
    { runId: "a/secret" }, { runId: "a\\secret" }, { runId: "a?secret" },
    { runId: "a".repeat(201) }, { runId: "a", force: true },
    { runId: "a", root: "/tmp" }, { runId: "a", ticketPath: "/tmp/ticket" },
    { runId: "a", workspace: "/tmp/workspace" },
    Object.assign(Object.create({ runId: valid }), {}),
    Object.assign(Object.create({}), { runId: valid }),
    Object.defineProperty({}, "runId", { get: () => valid }),
    Object.assign({ runId: valid }, { [Symbol("extra")]: true }),
  ];
  for (const payload of invalid) assert.throws(() => validateRecoveryPayload(payload), /payload|run ID|runId/i);
});

test("recovery IPC handlers validate and dispatch only the run ID", () => {
  const handlers = new Map();
  const ipcMain = { handle(channel, handler) { handlers.set(channel, handler); } };
  const calls = [];
  const provider = {};
  for (const method of ["retryReview", "retryIntegration", "cleanupRun"]) {
    provider[method] = (...args) => { calls.push({ method, args }); return method; };
  }
  registerPiRecoveryIpc(ipcMain, () => provider);

  assert.deepEqual([...handlers.keys()], ["pi:retry-review", "pi:retry-integration", "pi:cleanup-run"]);
  for (const [channel, method] of [["pi:retry-review", "retryReview"], ["pi:retry-integration", "retryIntegration"], ["pi:cleanup-run", "cleanupRun"]]) {
    assert.equal(handlers.get(channel)(null, { runId: valid }), method);
  }
  assert.deepEqual(calls, [
    { method: "retryReview", args: [valid] },
    { method: "retryIntegration", args: [valid] },
    { method: "cleanupRun", args: [valid] },
  ]);
  assert.throws(() => handlers.get("pi:cleanup-run")(null, { runId: valid, root: "/escape" }));
  assert.equal(calls.length, 3);
});
