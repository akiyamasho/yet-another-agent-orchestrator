const fs = require('node:fs');
const path = require('node:path');
function atomicWrite(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, file); }
function safeProjectPath(root, ...parts) {
  const project = path.resolve(root);
  const realProject = fs.realpathSync(project);
  const target = path.resolve(project, ...parts);
  if (!(target === project || target.startsWith(`${project}${path.sep}`))) throw new Error('Path is outside project root.');
  let current = project;
  for (const component of path.relative(project, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked path component: ${current}`);
    const real = fs.realpathSync(current);
    if (!(real === realProject || real.startsWith(`${realProject}${path.sep}`))) throw new Error('Path resolves outside project root.');
  }
  return target;
}
function projectStateFiles(root) {
  const dir = safeProjectPath(root, '.orchestration');
  const state = safeProjectPath(root, '.orchestration', 'state.json');
  const runs = safeProjectPath(root, '.orchestration', 'runs.jsonl');
  return { dir, state, runs };
}
function readState(root) {
  const file = projectStateFiles(root).state;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Unable to read orchestration state at ${file}: ${error.message}`);
  }
  let value;
  try { value = JSON.parse(text); } catch (error) {
    throw new Error(`Orchestration state is malformed at ${file}: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Orchestration state must be a JSON object at ${file}.`);
  return value;
}
function initialState() { return { scheduler: { enabled: false }, claims: {}, attempts: {}, runs: {} }; }
function loadState(root) { return { ...initialState(), ...readState(root) }; }
function saveState(root, state) { atomicWrite(projectStateFiles(root).state, state); return state; }
function appendRun(root, event) { const files = projectStateFiles(root); fs.mkdirSync(files.dir, { recursive: true }); fs.appendFileSync(files.runs, `${JSON.stringify({ ...event, timestamp: event.timestamp || new Date().toISOString() })}\n`, 'utf8'); }
function reconcileState(root, state = loadState(root), livePids = new Set(), liveRetryRunIds = new Set()) {
  const next = JSON.parse(JSON.stringify(state));
  const markStale = (entry) => {
    const missingProcess = entry.status === 'running' && !livePids.has(Number(entry.pid));
    const missingRetryTimer = entry.status === 'retrying' && !liveRetryRunIds.has(entry.runId);
    if (missingProcess || missingRetryTimer) {
      entry.status = 'stale';
      entry.error = missingRetryTimer ? 'Retry timer was not alive during restart reconciliation; the ticket can be claimed again.' : 'Orchestration process was not alive during restart reconciliation.';
      entry.reconciledAt = new Date().toISOString();
    }
  };
  for (const claim of Object.values(next.claims || {})) markStale(claim);
  for (const run of Object.values(next.runs || {})) markStale(run);
  saveState(root, next);
  return next;
}
module.exports = { atomicWrite, safeProjectPath, projectStateFiles, initialState, loadState, saveState, appendRun, reconcileState };
