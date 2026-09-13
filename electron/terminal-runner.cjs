const { spawn } = require("node:child_process");

const MAX_COMMAND_LENGTH = 4000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function makeTerminalRunner({ validateCwd, send }) {
  const runsBySender = new Map();
  let nextRun = 0;

  function senderRuns(sender) {
    let runs = runsBySender.get(sender);
    if (!runs) { runs = new Map(); runsBySender.set(sender, runs); }
    return runs;
  }

  function start(sender, input = {}) {
    if (!sender || sender.isDestroyed?.()) throw new Error("The terminal window is unavailable.");
    if (typeof input.command !== "string" || !input.command.trim()) throw new Error("Enter a command to run.");
    if (input.command.length > MAX_COMMAND_LENGTH) throw new Error(`Commands are limited to ${MAX_COMMAND_LENGTH} characters.`);
    const cwd = validateCwd(input.cwd);
    if (!cwd) throw new Error("That agent folder is not a registered project directory.");
    const runId = `terminal-${Date.now()}-${++nextRun}`;
    const child = spawn("/bin/zsh", ["-lc", input.command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const run = { child, cwd, outputBytes: 0, truncated: false, ended: false };
    senderRuns(sender).set(runId, run);
    const emit = (event) => { if (!sender.isDestroyed?.()) send(sender, "terminal:event", { runId, ...event }); };
    const output = (stream, text) => {
      if (run.ended || !text) return;
      const bytes = Buffer.byteLength(text);
      const remaining = MAX_OUTPUT_BYTES - run.outputBytes;
      if (remaining <= 0) { if (!run.truncated) { run.truncated = true; emit({ type: "output", stream: "stderr", text: "\n[output truncated at 1 MiB]\n" }); } return; }
      const clipped = bytes > remaining ? Buffer.from(text).subarray(0, remaining).toString("utf8") : text;
      run.outputBytes += Buffer.byteLength(clipped);
      emit({ type: "output", stream, text: clipped });
      if (bytes > remaining && !run.truncated) { run.truncated = true; emit({ type: "output", stream: "stderr", text: "\n[output truncated at 1 MiB]\n" }); }
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => output("stdout", text));
    child.stderr.on("data", (text) => output("stderr", text));
    child.on("error", (error) => { output("stderr", `${error.message}\n`); });
    child.on("close", (code, signal) => {
      run.ended = true;
      senderRuns(sender).delete(runId);
      emit({ type: "exit", code, signal, cwd, truncated: run.truncated });
    });
    emit({ type: "started", cwd });
    return { runId, cwd };
  }

  function cancel(sender, runId) {
    const run = runsBySender.get(sender)?.get(String(runId));
    if (!run) return false;
    run.child.kill("SIGTERM");
    setTimeout(() => { if (!run.ended) run.child.kill("SIGKILL"); }, 1000).unref?.();
    return true;
  }

  function closeSender(sender) { for (const run of runsBySender.get(sender)?.values() || []) run.child.kill("SIGTERM"); runsBySender.delete(sender); }
  function closeAll() { for (const sender of runsBySender.keys()) closeSender(sender); }
  return { start, cancel, closeSender, closeAll };
}

module.exports = { makeTerminalRunner, MAX_COMMAND_LENGTH, MAX_OUTPUT_BYTES };
