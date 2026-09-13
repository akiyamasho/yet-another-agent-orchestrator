const test = require("node:test");
const assert = require("node:assert/strict");
const { makeTerminalRunner } = require("./terminal-runner.cjs");
const ROOT = process.cwd();

function harness(validateCwd = (cwd) => cwd === ROOT ? cwd : null) {
  const events = [];
  const sender = { isDestroyed: () => false, send: (_channel, event) => events.push(event) };
  const runner = makeTerminalRunner({ validateCwd, send: (target, channel, event) => target.send(channel, event) });
  return { runner, sender, events };
}

test("runs commands only in an approved exact root and streams exit", async () => {
  const { runner, sender, events } = harness();
  await new Promise((resolve, reject) => {
    const timer = setInterval(() => { if (events.some((event) => event.type === "exit")) { clearInterval(timer); resolve(); } }, 10);
    runner.start(sender, { cwd: ROOT, command: "printf 'hello'" });
    setTimeout(() => { clearInterval(timer); reject(new Error("terminal did not exit")); }, 1500).unref();
  });
  assert.equal(events.find((event) => event.type === "output").text, "hello");
  assert.equal(events.find((event) => event.type === "exit").code, 0);
  assert.throws(() => runner.start(sender, { cwd: `${ROOT}/child`, command: "pwd" }), /registered project directory/);
});

test("isolates run ids by sender and cancels active work", async () => {
  const { runner, sender } = harness();
  const other = { isDestroyed: () => false, send() {} };
  const first = runner.start(sender, { cwd: ROOT, command: "sleep 10" });
  assert.equal(runner.cancel(other, first.runId), false);
  assert.equal(runner.cancel(sender, first.runId), true);
  await new Promise((resolve) => setTimeout(resolve, 80));
});

test("rejects empty and oversized commands", () => {
  const { runner, sender } = harness();
  assert.throws(() => runner.start(sender, { cwd: ROOT, command: " " }), /Enter a command/);
  assert.throws(() => runner.start(sender, { cwd: ROOT, command: "x".repeat(4001) }), /limited/);
});
