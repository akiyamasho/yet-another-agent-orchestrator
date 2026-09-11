const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn: spawnProcess, execFileSync } = require('node:child_process');
const { parseTicket, updateTicketAtomic } = require('./tickets.cjs');
const { parseWorkflow, PI_WORKFLOW_MODELS } = require('./workflow.cjs');
const { preflight, captureReviewed, reconcileIntegration, integrateReviewed, cleanupWorktree, worktreeEntries } = require('./integration.cjs');
const { loadState, saveState, appendRun, reconcileState, safeProjectPath, projectStateFiles } = require('./state.cjs');

function walkTickets(root) {
  const found = []; const dir = safeProjectPath(root, '.tickets');
  function visit(current) {
    if (!fs.existsSync(current)) return;
    const stat = fs.lstatSync(current); if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked .tickets path: ${current}`);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing symlinked .tickets path: ${file}`);
      if (entry.isDirectory()) visit(file); else if (entry.isFile() && entry.name.endsWith('.md')) found.push(file);
    }
  }
  visit(dir); return found;
}
function sanitizeTicketId(id) { return String(id).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'ticket'; }
function canonicalRoot(root) {
  const real = fs.realpathSync(path.resolve(String(root)));
  if (!fs.statSync(real).isDirectory()) throw new Error(`Project root is not a directory: ${root}`);
  return real;
}
function ticketHash(filePath) { return crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 10); }
function safeChildPath(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path is outside project root.');
  safeProjectPath(root, ...relative.split(path.sep).filter(Boolean)); return true;
}
function claimKey(ticket) { return path.resolve(ticket.filePath); }
function assistantText(output) {
  for (const line of String(output).split(/\r?\n/).reverse()) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'message_end' || event.message?.role !== 'assistant') continue;
    const blocks = event.message.content;
    return Array.isArray(blocks) ? blocks.filter((block) => block?.type === 'text').map((block) => block.text || '').join('') : String(blocks || '');
  }
  return '';
}
function extractPlannerPlan(output) {
  const text = assistantText(output);
  if (!text) throw new Error('Planner did not return an authoritative assistant message_end text block.');
  try { return JSON.parse(text); } catch { throw new Error('Planner final assistant message was not a strict JSON object.'); }
}
function validatePlannerPlan(plan, existing = []) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.tickets) || plan.tickets.length < 2 || plan.tickets.length > 50) throw new Error('Planner returned an invalid ticket count.');
  const ids = new Set(existing.map((x) => String(x.id).toLowerCase())); const items = plan.tickets; let roots = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || !/^[a-z0-9._-]{1,80}$/.test(item.id) || ids.has(item.id.toLowerCase())) throw new Error('Planner returned invalid or duplicate ticket ID.');
    ids.add(item.id.toLowerCase());
    if (!String(item.title || '').trim() || String(item.title).length > 240 || String(item.objective || '').length > 4000) throw new Error('Planner returned invalid ticket text.');
    if (!Array.isArray(item.acceptanceCriteria) || item.acceptanceCriteria.length < 1 || item.acceptanceCriteria.length > 50 || item.acceptanceCriteria.some((x) => typeof x !== 'string' || !x.trim() || x.length > 500)) throw new Error('Planner acceptance criteria are invalid.');
    if (!Array.isArray(item.blockedBy) || item.blockedBy.some((ref) => typeof ref !== 'string')) throw new Error('Planner blockedBy must be an array of ticket IDs.');
    if (new Set(item.blockedBy).size !== item.blockedBy.length) throw new Error('Planner ticket contains duplicate blocker references.');
    if (item.parentId == null) roots++; else if (typeof item.parentId !== 'string' || item.parentId === item.id) throw new Error('Planner ticket has an invalid parent.');
    for (const ref of [item.parentId, ...item.blockedBy]) if (ref && (!/^[a-z0-9._-]{1,80}$/.test(ref) || !items.some((x) => x.id === ref))) throw new Error(`Planner reference is not project-local: ${ref}`);
    if (item.blockedBy.includes(item.id)) throw new Error('Planner ticket cannot block itself.');
  }
  if (roots !== 1) throw new Error('Planner must return exactly one root ticket.');
  const graph = new Map(items.map((x) => [x.id, [x.parentId, ...(x.blockedBy || [])].filter(Boolean)]));
  const visiting = new Set(); const visited = new Set(); const visit = (id) => { if (visiting.has(id)) throw new Error('Planner references contain a cycle.'); if (visited.has(id)) return; visiting.add(id); for (const ref of graph.get(id) || []) visit(ref); visiting.delete(id); visited.add(id); }; for (const id of graph.keys()) visit(id);
  const root = items.find((x) => x.parentId == null); if (root.state && root.state !== 'planned') throw new Error('Planner root must be planned.');
  if (items.some((x) => x !== root && x.state && x.state !== 'todo')) throw new Error('Planner children must be todo.');
  return items;
}
function validateRecoveryRunId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error('Malformed Pi run ID.');
  return value;
}
function runId(prefix = 'pi', scope = '') {
  const projectKey = scope ? crypto.createHash('sha1').update(path.resolve(scope)).digest('hex').slice(0, 8) : 'global';
  return `${prefix}-${projectKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function piChildEnvironment() {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  return env;
}
function assertPiWorkflowModels(workflow) {
  for (const [key, expected] of Object.entries(PI_WORKFLOW_MODELS)) {
    if (workflow[key] !== expected) throw new Error(`Unsupported Pi workflow model override for ${key}: ${String(workflow[key])}. Expected ${expected}.`);
  }
}

class PiMarkdownProvider {
  constructor({ roots = [], spawn = spawnProcess, execFile = execFileSync, isProcessAlive, integrationRetryMax = 5, integrationRetryBaseDelay = 100 } = {}) {
    this.roots = [...new Set(roots.map(canonicalRoot))];
    this.spawn = spawn;
    this.execFile = execFile;
    this.isProcessAlive = isProcessAlive || ((pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error?.code === 'ESRCH') return false; throw error; } });
    this.children = new Map();
    this.outputs = new Map();
    this.queueTimers = new Map();
    this.runtimeStatuses = new Map();
    this.retryTimers = new Map();
    this.integrationRetryTimers = new Map();
    this.integrationRetryMax = integrationRetryMax;
    this.integrationRetryBaseDelay = integrationRetryBaseDelay;
    this.escalationTimers = new Map();
    this.reconcile();
    for (const root of this.roots) if (loadState(root).scheduler?.enabled) this.startQueue(root);
  }
  updateRoots(nextRoots = []) {
    const next = new Set(nextRoots.map(canonicalRoot));
    for (const root of this.roots) {
      if (next.has(root)) continue;
      this.stopQueueTimer(root);
      for (const [runIdValue, entry] of this.children) if ((entry.root || entry.ticket?.cwd) === root) void this.interrupt(runIdValue);
      for (const [key, pending] of [...this.retryTimers, ...this.integrationRetryTimers]) {
        if (pending.root !== root) continue;
        clearTimeout(pending.timer);
        this.retryTimers.delete(key); this.integrationRetryTimers.delete(key); this.integrationRetryAttempts?.delete(key);
        this.markPendingRetryInterrupted(pending);
      }
      for (const file of [...this.runtimeStatuses.keys()]) if (file.startsWith(`${root}${path.sep}`)) this.runtimeStatuses.delete(file);
    }
    this.roots = [...next];
    this.reconcile();
    for (const root of this.roots) if (loadState(root).scheduler?.enabled) this.startQueue(root);
    return this.roots;
  }
  setRoots(nextRoots = []) { return this.updateRoots(nextRoots); }
  reconcile() {
    const live = new Set([...this.children.values()].map((entry) => entry.child.pid));
    const liveRetries = new Set([...this.retryTimers.values(), ...this.integrationRetryTimers.values()].map((pending) => pending.runId));
    for (const root of this.roots) {
      let state = reconcileState(root, loadState(root), live, liveRetries);
      for (const [key, claim] of Object.entries(state.claims || {})) {
        if (!claim.integration || !['pending_review', 'integration_pending', 'integrating', 'completing', 'integrated'].includes(claim.integration.phase)) continue;
        try {
          this.assertDeterministicIntegrationWorkspace(claim, root);
          const wasCompleting = claim.integration.phase === 'completing';
          // A pending review has no durable reviewer ownership after restart.
          // Never guess that it is safe to relaunch or integrate it.
          if (claim.integration.phase === 'pending_review') {
            claim.phase = 'needs_attention'; claim.status = 'needs_attention';
            claim.error = 'Review interrupted; retry review.';
            state.runs[claim.runId] = { ...state.runs[claim.runId], ...claim };
            appendRun(root, { event: 'needs_attention', runId: claim.runId, ticketId: claim.ticketId, error: claim.error });
            this.runtimeStatuses.set(claim.ticketPath, 'needs_attention');
            continue;
          }
          // Integrated claims are historical records. Reconciliation must never
          // re-finalize them when a later integration has moved HEAD.
          if (claim.integration.phase === 'integrated') {
            if (claim.integration.cleanup?.phase === 'cleaned' || claim.integration.cleanup?.phase === 'needs_attention' || (claim.integration.cleanup?.phase && !['pending', 'cleaning'].includes(claim.integration.cleanup.phase))) continue;
            try { this.cleanupRun(claim.runId, { automatic: true }); state = loadState(root); }
            catch (error) { claim.integration = { ...claim.integration, cleanup: { ...(claim.integration.cleanup || {}), phase: 'needs_attention', error: error.message, failedAt: new Date().toISOString() } }; claim.status = 'needs_attention'; claim.error = error.message; state.claims[key] = claim; state.runs[claim.runId] = { ...state.runs[claim.runId], ...claim }; appendRun(root, { event: 'cleanup-needs-attention', runId: claim.runId, ticketId: claim.ticketId, error: error.message }); }
            continue;
          }
          // Manual recovery failures retain a retryable integration sub-phase,
          // but must wait for an explicit retry rather than replaying on reload.
          if (claim.phase === 'needs_attention') continue;
          const result = reconcileIntegration({ metadata: claim.integration, execFile: this.execFile });
          claim.integration = result;
          if (['integration_pending', 'integrating', 'completing'].includes(result.phase)) {
            this.attemptIntegration(root, key, claim, state, true);
          } else {
            claim.phase = result.phase; claim.status = result.phase === 'integrated' ? 'completed' : claim.status;
            state.runs[claim.runId] = { ...state.runs[claim.runId], ...claim };
            if (result.phase === 'integrated') { const ticket = this.resolveTicket(claim.ticketPath); updateTicketAtomic(claim.ticketPath, { state: 'done' }); if (!wasCompleting) this.completeReadyAncestors(ticket, claim.integration.mode === 'worktree'); }
          }
        } catch (error) {
          if (error.code === 'INTEGRATION_LOCK_BUSY') { appendRun(root, { event: 'integration-deferred', runId: claim.runId, ticketId: claim.ticketId, error: error.message }); if (this.scheduleIntegrationRetry(root, key, claim.runId)) { const latest = loadState(root); state.claims = latest.claims; state.runs = latest.runs; } continue; }
          claim.phase = 'needs_attention'; claim.status = 'needs_attention'; claim.error = `Restart reconciliation refused integration: ${error.message}`; state.runs[claim.runId] = { ...state.runs[claim.runId], ...claim }; appendRun(root, { event: 'needs_attention', runId: claim.runId, ticketId: claim.ticketId, error: claim.error });
        }
      }
      saveState(root, state);
    }
  }
  assertDeterministicIntegrationWorkspace(claim, root) {
    const ticket = this.resolveTicket(claim.ticketPath);
    const workflow = parseWorkflow(root);
    if (workflow.workspaceMode !== 'worktree') return ticket;
    const expected = path.join(root, '.orchestration', 'workspaces', `${sanitizeTicketId(ticket.id)}-${ticketHash(ticket.filePath)}`);
    if (path.resolve(claim.integration.ownedWorkspace) !== path.resolve(expected)) throw new Error('Integration metadata points outside the deterministic ticket workspace.');
    const expectedTicket = path.join(expected, path.relative(root, ticket.filePath));
    if (path.resolve(claim.integration.sourceTicketPath || expectedTicket) !== path.resolve(expectedTicket)) throw new Error('Integration metadata points to a different ticket workspace.');
    return ticket;
  }
  cleanupPids(root, claim) {
    const pids = new Set();
    for (const [id, entry] of this.children) if ((entry.root || entry.ticket?.cwd) === root && (entry.ticket?.filePath === claim.ticketPath || id === claim.runId)) pids.add(entry.child.pid);
    for (const item of Object.values(loadState(root).runs || {})) if (item.ticketPath === claim.ticketPath && ['running', 'retrying', 'cleaning'].includes(item.status) && item.pid) pids.add(item.pid);
    return [...pids];
  }
  persistCleanupAttention(root, state, claim, runIdValue, error, claimKeyValue) {
    const message = error instanceof Error ? error.message : String(error);
    claim.integration = { ...(claim.integration || {}), cleanup: { ...(claim.integration?.cleanup || {}), phase: 'needs_attention', error: message, failedAt: new Date().toISOString() } };
    claim.status = 'needs_attention'; claim.phase = claim.integration.phase === 'integrated' ? 'needs_attention' : 'needs_attention'; claim.error = message;
    state.claims[claimKeyValue || claim.ticketPath] = claim; state.runs[runIdValue] = { ...(state.runs[runIdValue] || {}), ...claim }; saveState(root, state);
    appendRun(root, { event: 'cleanup-needs-attention', runId: runIdValue, ticketId: claim.ticketId, error: message });
  }
  cleanupRun(runIdValue, { automatic = false } = {}) {
    const id = validateRecoveryRunId(runIdValue);
    const matches = []; for (const root of this.roots) { const state = loadState(root); const run = state.runs?.[id]; if (run) matches.push({ root, state, run, key: Object.keys(state.claims || {}).find((key) => state.claims[key]?.runId === id) }); }
    if (matches.length !== 1) throw new Error(matches.length ? 'Pi run ID is ambiguous.' : 'Pi run was not found in a registered project root.');
    const { root, state, run, key } = matches[0]; const claim = (key && state.claims[key]) || run;
    if (!run.integration || run.integration.mode !== 'worktree' || !claim.integration || claim.integration.mode !== 'worktree') throw new Error('Cleanup is only available for worktree integrations.');
    let ticket, workflow;
    try { ticket = this.resolveTicket(claim.ticketPath); workflow = parseWorkflow(root); if (workflow.workspaceMode !== 'worktree') throw new Error('Worktree cleanup is not enabled.'); } catch (error) { this.persistCleanupAttention(root, state, claim, id, error, key); throw error; }
    const expected = path.join(root, '.orchestration', 'workspaces', `${sanitizeTicketId(ticket.id)}-${ticketHash(ticket.filePath)}`); const expectedBranch = `constellation/${sanitizeTicketId(ticket.id)}-${ticketHash(ticket.filePath)}`;
    try {
      if (String(claim.integration.ownedWorkspace) !== String(expected)) throw new Error('Integration metadata ownedWorkspace does not match deterministic workspace.');
      const expectedTicket = path.join(expected, path.relative(root, ticket.filePath));
      if (String(claim.integration.sourceTicketPath) !== String(expectedTicket)) throw new Error('Integration metadata source ticket does not match deterministic ticket workspace.');
      if (claim.integration.sourceBranch !== expectedBranch) throw new Error('Integration metadata source branch does not match deterministic ticket branch.');
    } catch (error) { this.persistCleanupAttention(root, state, claim, id, error, key); throw error; }
    const cleanup = claim.integration.cleanup || {};
    const retryLive = [...this.retryTimers.values(), ...this.integrationRetryTimers.values()].some((item) => item.root === root && item.ticketPath === claim.ticketPath);
    if (retryLive) { const error = new Error('An owned retry process is still running.'); this.persistCleanupAttention(root, state, claim, id, error, key); throw error; }
    if (cleanup.phase === 'cleaned') return { runId: id, ok: true, cleanup: cleanup.phase, action: 'already-cleaned' };
    const listed = worktreeEntries(root, this.execFile).some((item) => item.path === path.resolve(expected));
    if (cleanup.phase === 'cleaning' && !listed && !fs.existsSync(expected)) { const next = { ...claim.integration, cleanup: { ...cleanup, phase: 'cleaned', cleanedAt: cleanup.cleanedAt || new Date().toISOString(), error: undefined } }; claim.integration = next; claim.status = 'completed'; claim.phase = 'integrated'; claim.error = undefined; state.claims[key] = claim; state.runs[id] = { ...run, ...claim }; saveState(root, state); return { runId: id, ok: true, cleanup: 'cleaned', action: 'recovered' }; }
    if (!listed && !fs.existsSync(expected)) { const error = new Error('Owned workspace is missing before cleanup began; manual attention required.'); this.persistCleanupAttention(root, state, claim, id, error, key); throw error; }
    const cleaning = { ...claim.integration, cleanup: { ...cleanup, phase: 'cleaning', startedAt: cleanup.startedAt || new Date().toISOString(), error: undefined } }; claim.integration = cleaning; state.claims[key] = claim; state.runs[id] = { ...run, ...claim }; saveState(root, state);
    try { const result = cleanupWorktree({ metadata: cleaning, expectedWorkspace: expected, expectedBranch, liveProcessCheck: this.isProcessAlive, ownedPids: this.cleanupPids(root, claim), execFile: this.execFile }); claim.integration = { ...cleaning, cleanup: { ...cleaning.cleanup, ...result } }; claim.status = 'completed'; claim.phase = 'integrated'; claim.error = undefined; state.claims[key] = claim; state.runs[id] = { ...state.runs[id], ...claim }; saveState(root, state); appendRun(root, { event: 'cleaned', runId: id, ticketId: claim.ticketId }); return { runId: id, ok: true, cleanup: 'cleaned', action: 'removed' }; }
    catch (error) { claim.integration = { ...cleaning, cleanup: { ...cleaning.cleanup, phase: 'needs_attention', error: error.message, failedAt: new Date().toISOString() } }; claim.status = 'needs_attention'; claim.phase = 'needs_attention'; claim.error = error.message; state.claims[key] = claim; state.runs[id] = { ...state.runs[id], ...claim }; saveState(root, state); throw error; }
  }
  hasLivePersistedWorker(root, ticketPath) {
    const state = loadState(root);
    for (const run of Object.values(state.runs || {})) {
      if (run.ticketPath !== ticketPath || !['running', 'worker', 'reviewer'].includes(run.status) && !['worker', 'reviewer'].includes(run.phase)) continue;
      if (!run.pid) continue;
      try {
        if (this.isProcessAlive(Number(run.pid))) return true;
      } catch (error) {
        throw new Error(`Refusing retry while persisted process liveness is unknown (PID ${run.pid}: ${error.code || error.message}).`);
      }
    }
    return false;
  }
  retryReview(runIdValue) {
    const id = validateRecoveryRunId(runIdValue); const matches = this.roots.map((root) => ({ root, state: loadState(root) })).flatMap(({ root, state }) => state.runs?.[id] ? [{ root, state, run: state.runs[id], key: Object.keys(state.claims || {}).find((key) => state.claims[key]?.runId === id) }] : []);
    if (matches.length !== 1) throw new Error(matches.length ? 'Pi run ID is ambiguous.' : 'Pi run was not found in a registered project root.');
    const { root, state, run } = matches[0]; const claim = run;
    if (!claim?.integration || claim.integration.phase !== 'pending_review') throw new Error('Retry review is only allowed for a pending review run.');
    const ticket = this.assertDeterministicIntegrationWorkspace(claim, root);
    const workflow = parseWorkflow(root);
    if (workflow.workspaceMode !== 'worktree' || claim.integration.mode !== 'worktree') throw new Error('Review retry requires a worktree integration.');
    const expected = path.join(root, '.orchestration', 'workspaces', `${sanitizeTicketId(ticket.id)}-${ticketHash(ticket.filePath)}`);
    const expectedTicket = path.join(expected, path.relative(root, ticket.filePath));
    if (path.resolve(claim.integration.ownedWorkspace) !== path.resolve(expected) || path.resolve(claim.integration.sourceTicketPath || '') !== path.resolve(expectedTicket)) throw new Error('Review metadata no longer matches the deterministic workspace or source ticket.');
    const current = preflight({ root, workspace: expected, sourceBranch: claim.integration.sourceBranch, ticketPath: expectedTicket, execFile: this.execFile });
    if (current.sourceHead !== claim.integration.sourceHead || current.sourceBranch !== claim.integration.sourceBranch || current.destinationBranch !== claim.integration.destinationBranch || current.baseHead !== claim.integration.baseHead) throw new Error('Reviewed source or destination identity moved since review.');
    if (this.hasLivePersistedWorker(root, claim.ticketPath)) throw new Error('A reviewer or worker for this ticket is already running.');
    return this.startWorker(ticket, { workflow, reviewer: true, allowAnyState: true, integration: claim.integration });
  }
  retryIntegration(runIdValue) {
    const id = validateRecoveryRunId(runIdValue); const matches = this.roots.map((root) => ({ root, state: loadState(root) })).flatMap(({ root, state }) => { const run = state.runs?.[id]; return run ? [{ root, state, run, key: Object.keys(state.claims || {}).find((key) => state.claims[key]?.runId === id) }] : []; });
    if (matches.length !== 1) throw new Error(matches.length ? 'Pi run ID is ambiguous.' : 'Pi run was not found in a registered project root.'); const { root, state, run, key } = matches[0]; const claim = state.claims[key]; const phase = claim?.integration?.phase;
    if (!claim || (!['integration_pending', 'integrating', 'completing'].includes(phase) && !(claim.phase === 'needs_attention' && ['integration_pending', 'integrating', 'completing'].includes(claim.integration?.phase)))) throw new Error('Retry integration is not allowed for this run (pending_review is never retryable).');
    const ticket = this.assertDeterministicIntegrationWorkspace(claim, root);
    const workflow = parseWorkflow(root);
    if (workflow.workspaceMode !== 'worktree' || claim.integration.mode !== 'worktree') throw new Error('Integration retry requires a worktree integration.');
    const expectedWorkspace = path.join(root, '.orchestration', 'workspaces', `${sanitizeTicketId(ticket.id)}-${ticketHash(ticket.filePath)}`);
    const expectedTicket = path.join(expectedWorkspace, path.relative(root, ticket.filePath));
    const expectedBranch = `constellation/${sanitizeTicketId(ticket.id)}-${ticketHash(ticket.filePath)}`;
    if (path.resolve(claim.integration.ownedWorkspace) !== path.resolve(expectedWorkspace) || path.resolve(claim.integration.sourceTicketPath || '') !== path.resolve(expectedTicket)) throw new Error('Integration metadata no longer matches the deterministic workspace or source ticket.');
    if (claim.integration.sourceBranch !== expectedBranch) throw new Error('Integration metadata source branch does not match the deterministic ticket branch.');
    if (path.resolve(claim.integration.destinationRoot || '') !== path.resolve(root) || path.resolve(claim.integration.topLevel || '') !== path.resolve(root) || !claim.integration.destinationBranch) throw new Error('Integration metadata no longer matches the project root.');
    try {
      const current = preflight({ root, workspace: expectedWorkspace, sourceBranch: expectedBranch, ticketPath: expectedTicket, execFile: this.execFile });
      if (current.destinationBranch !== claim.integration.destinationBranch) throw new Error('Integration metadata destination branch no longer matches the project branch.');
      if (claim.phase === 'needs_attention') claim.phase = phase;
      return this.attemptIntegration(root, key, claim, state);
    } catch (error) {
      const message = `Integration retry failed: ${error instanceof Error ? error.message : String(error)} Retry integration after resolving the issue.`;
      const retryablePhase = ['integration_pending', 'integrating', 'completing'].includes(claim.integration?.phase) ? claim.integration.phase : phase;
      claim.integration = { ...claim.integration, phase: retryablePhase, error: message };
      claim.phase = 'needs_attention'; claim.status = 'needs_attention'; claim.error = message;
      state.claims[key] = claim; state.runs[id] = { ...state.runs[id], ...claim }; saveState(root, state);
      appendRun(root, { event: 'integration-needs-attention', runId: id, ticketId: claim.ticketId, phase: retryablePhase, error: message });
      this.runtimeStatuses.set(claim.ticketPath, 'needs_attention');
      throw error;
    }
  }
  scheduleIntegrationRetry(root, key, runIdValue) {
    const retryKey = `${path.resolve(root)}|${key}`; const previous = this.integrationRetryTimers.get(retryKey); if (previous) return;
    const attempts = (this.integrationRetryAttempts?.get(retryKey) || 0) + 1; this.integrationRetryAttempts ??= new Map(); this.integrationRetryAttempts.set(retryKey, attempts);
    if (attempts > this.integrationRetryMax) { this.integrationRetryAttempts.delete(retryKey); this.markIntegrationRetryExhausted(root, key, runIdValue); return true; }
    const timer = setTimeout(() => { this.integrationRetryTimers.delete(retryKey); if (this.roots.includes(path.resolve(root))) this.reconcile(); }, Math.min(1000, this.integrationRetryBaseDelay * 2 ** (attempts - 1)));
    timer.unref?.(); this.integrationRetryTimers.set(retryKey, { timer, root: path.resolve(root), ticketPath: key, runId: runIdValue }); return false;
  }
  markIntegrationRetryExhausted(root, key, runIdValue) {
    const state = loadState(root); const claim = state.claims[key];
    if (!claim || claim.runId !== runIdValue) return;
    const error = 'Integration retry limit exhausted; retry integration.';
    const integrationPhase = claim.integration?.phase;
    claim.phase = 'needs_attention'; claim.status = 'needs_attention'; claim.error = error;
    if (claim.integration) claim.integration = { ...claim.integration, phase: integrationPhase };
    state.claims[key] = claim; state.runs[runIdValue] = { ...state.runs[runIdValue], ...claim, phase: 'needs_attention', status: 'needs_attention', error };
    saveState(root, state); appendRun(root, { event: 'needs_attention', runId: runIdValue, ticketId: claim.ticketId, error });
    this.runtimeStatuses.set(claim.ticketPath, 'needs_attention');
  }
  attemptIntegration(root, key, claim, state, restart = false) {
    const persist = (integration) => { claim.integration = integration; claim.phase = integration.phase; claim.status = integration.phase === 'integrated' ? 'completed' : 'completed'; state.claims[key] = claim; state.runs[claim.runId] = { ...state.runs[claim.runId], ...claim }; saveState(root, state); appendRun(root, { event: integration.phase, runId: claim.runId, ticketId: claim.ticketId, destinationHeadBeforeMerge: integration.destinationHeadBeforeMerge }); };
    const result = integrateReviewed({ metadata: claim.integration, execFile: this.execFile, persist,
      prepare: () => ({ completionPaths: this.readyAncestorPaths(claim.ticketPath, claim.integration).map((item) => path.relative(root, item.filePath)) }),
      finalize: (integration) => this.completeIntegratedAncestors(root, claim.ticketPath, integration) });
    const successfulIntegration = { ...result }; delete successfulIntegration.error;
    claim.integration = { ...successfulIntegration, cleanup: { phase: 'pending', requestedAt: new Date().toISOString() } }; claim.phase = 'integrated'; claim.status = 'completed'; state.claims[key] = claim; state.runs[claim.runId] = { ...state.runs[claim.runId], ...claim }; saveState(root, state);
    const ticket = this.resolveTicket(claim.ticketPath); updateTicketAtomic(ticket.filePath, { state: 'done' }); this.runtimeStatuses.set(ticket.filePath, 'done');
    appendRun(root, { event: 'integrated', runId: claim.runId, ticketId: claim.ticketId, destinationHead: result.finalDestinationHead });
    try { this.cleanupRun(claim.runId, { automatic: true }); } catch (error) { /* integration remains historical truth; cleanup is durable attention */ }
    return loadState(root).claims[key].integration;
  }
  listTickets() {
    const tickets = [...new Set(this.roots.flatMap(walkTickets))].map((file) => parseTicket(file, fs.readFileSync(file, 'utf8')));
    const idsByRoot = new Map();
    const ticketsByIdentity = new Map();
    for (const ticket of tickets) {
      const id = ticket.id.toLowerCase();
      if (!idsByRoot.has(ticket.cwd)) idsByRoot.set(ticket.cwd, new Set());
      idsByRoot.get(ticket.cwd).add(id);
      const key = `${ticket.cwd}\u0000${id}`;
      const matches = ticketsByIdentity.get(key) || [];
      matches.push(ticket);
      ticketsByIdentity.set(key, matches);
    }
    return tickets.map((ticket) => {
      const duplicate = ticketsByIdentity.get(`${ticket.cwd}\u0000${ticket.id.toLowerCase()}`)?.length > 1;
      const ids = idsByRoot.get(ticket.cwd) || new Set();
      const missingParent = ticket.parentId && !ids.has(String(ticket.parentId).toLowerCase()) ? ticket.parentId : undefined;
      const missingBlocker = ticket.blockedBy.find((id) => !ids.has(String(id).toLowerCase()));
      const issue = duplicate ? `Duplicate ticket ID: ${ticket.id}` : missingParent ? `Missing parent ticket: ${missingParent}` : missingBlocker ? `Missing blocker ticket: ${missingBlocker}` : undefined;
      if (issue) return { ...ticket, status: 'needs_attention', state: 'needs_attention', duplicateId: duplicate, issue };
      const status = this.runtimeStatuses.get(ticket.filePath);
      const persisted = loadState(ticket.cwd).claims?.[claimKey(ticket)]?.status;
      const persistedClaim = loadState(ticket.cwd).claims?.[claimKey(ticket)];
      const attention = persisted === 'needs_attention' ? 'needs_attention' : undefined;
      const review = persistedClaim && ['pending_review', 'integration_pending', 'integrating', 'completing'].includes(persistedClaim.integration?.phase || persistedClaim.phase) ? 'review' : undefined;
      return status ? { ...ticket, status, state: status } : attention ? { ...ticket, status: attention, state: attention, issue: persistedClaim.error } : review ? { ...ticket, status: review, state: review } : ticket;
    });
  }
  runSnapshot(root) {
    const state = loadState(root);
    return Object.values(state.runs || {}).map((run) => ({
      runId: run.runId, ticketId: run.ticketId, parentTicketId: run.parentTicketId, phase: run.phase, status: run.status,
      cwd: run.workspace || run.cwd, projectRoot: root, model: run.model, workspace: run.workspace, branch: run.branch,
      startedAt: run.startedAt, finishedAt: run.finishedAt, summary: run.summary, objective: run.objective,
      code: run.code, signal: run.signal, error: run.error, ticketPath: run.ticketPath, sessionDir: run.sessionDir,
      integration: run.integration, integrationPhase: run.integration?.phase, reviewResult: run.reviewResult || run.integration?.reviewResult,
      cleanupPhase: run.integration?.cleanup?.phase, sourceHead: run.integration?.sourceHead, mergeCommit: run.integration?.mergeCommit,
      completionCommit: run.integration?.completionCommit, finalDestinationHead: run.integration?.finalDestinationHead,
      integrationError: run.integration?.error, cleanupError: run.integration?.cleanup?.error,
    })).slice(-100);
  }
  snapshot() {
    const projects = this.roots.map((root) => { const state = loadState(root); const live = [...this.children.values()].filter((entry) => (entry.root || entry.ticket?.cwd) === root); return { root, ...state.scheduler, running: live.length, liveChildren: live.length }; });
    const runs = this.roots.flatMap((root) => this.runSnapshot(root));
    const runEvents = this.roots.flatMap((root) => {
      try { return fs.readFileSync(projectStateFiles(root).runs, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-200).map((line) => JSON.parse(line)); } catch (error) { if (/symlink|outside project/i.test(error.message)) throw error; return []; }
    }).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).slice(-200);
    return { connected: true, provider: 'pi', tickets: this.listTickets(), projects: this.roots, runs, runEvents,
      scheduler: { enabled: projects.some((project) => project.enabled), running: projects.reduce((total, project) => total + project.running, 0), projects } };
  }
  assertRoot(target) {
    let resolved;
    try { resolved = canonicalRoot(target); } catch { throw new Error('Project root is not registered.'); }
    if (!this.roots.includes(resolved)) throw new Error('Project root is not registered.');
    return resolved;
  }
  assertPathInRoot(target) {
    let resolved;
    try { resolved = fs.realpathSync(path.resolve(String(target))); } catch { resolved = path.resolve(String(target)); }
    if (!this.roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) throw new Error('Ticket path is outside a registered project root.');
    return resolved;
  }
  resolveTicket(value) {
    const text = String(value);
    const matches = this.listTickets().filter((ticket) => ticket.id === text);
    let direct;
    try { direct = fs.realpathSync(path.resolve(text)); } catch { direct = path.resolve(text); }
    const byPath = this.listTickets().find((ticket) => ticket.filePath === direct);
    if (byPath) return byPath;
    if (matches.length > 1) throw new Error(`Pi ticket ID is ambiguous across projects: ${text}. Use its canonical ticket path.`);
    if (matches.length === 1) return matches[0];
    throw new Error('Pi ticket was not found in a registered project root.');
  }
  readTicket(value) { const ticket = this.resolveTicket(value); return { provider: 'pi', threadId: ticket.id, status: ticket.status, updatedAt: ticket.updatedAt, items: [{ id: 'ticket-markdown', kind: 'message', role: 'user', text: fs.readFileSync(ticket.filePath, 'utf8'), timestamp: ticket.updatedAt }], ticket }; }
  readRun(runIdValue) {
    const runId = String(runIdValue); for (const root of this.roots) { const state = loadState(root); const run = state.runs?.[runId]; if (!run) continue;
      let items = []; try { items = fs.readFileSync(projectStateFiles(root).runs, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.runId === runId).slice(-200); } catch (error) { if (/symlink|outside project/i.test(error.message)) throw error; }
      return { provider: 'pi', threadId: runId, status: run.status, phase: run.phase, integrationPhase: run.integration?.phase, reviewResult: run.reviewResult || run.integration?.reviewResult, cleanupPhase: run.integration?.cleanup?.phase, sourceHead: run.integration?.sourceHead, mergeCommit: run.integration?.mergeCommit, completionCommit: run.integration?.completionCommit, finalDestinationHead: run.integration?.finalDestinationHead, integrationError: run.integration?.error, cleanupError: run.integration?.cleanup?.error, model: run.model, workspace: run.workspace, branch: run.branch, summary: run.summary, error: run.error, items };
    } throw new Error('Pi run was not found in a registered project root.');
  }
  createTicket({ cwd, title, objective = '', acceptanceCriteria = [], parentId, blockedBy = [], id, state, internalValidated = false } = {}) {
    const root = this.assertRoot(cwd);
    const dir = safeProjectPath(root, '.tickets');
    fs.mkdirSync(dir, { recursive: true });
    const explicit = id !== undefined && id !== null;
    if (explicit && !/^[A-Za-z0-9._-]{1,80}$/.test(String(id))) throw new Error('Ticket ID must contain only letters, numbers, dot, underscore, or hyphen.');
    if (!Array.isArray(acceptanceCriteria) || !Array.isArray(blockedBy)) throw new Error('Ticket criteria and blockers must be arrays.');
    const existing = this.listTickets().filter((ticket) => ticket.cwd === root);
    const currentIds = new Set(existing.map((ticket) => ticket.id.toLowerCase()));
    const safe = explicit ? String(id) : sanitizeTicketId(title || 'ticket');
    let uniqueId = safe;
    let n = 2;
    while (currentIds.has(uniqueId.toLowerCase()) || fs.existsSync(safeProjectPath(root, '.tickets', `${uniqueId}.md`))) {
      if (explicit) throw new Error(`Ticket ID already exists: ${uniqueId}`);
      uniqueId = `${safe}-${n++}`;
    }
    if (!internalValidated) for (const ref of [parentId, ...blockedBy].filter(Boolean)) if (!currentIds.has(String(ref).toLowerCase())) throw new Error(`Ticket reference is not project-local: ${ref}`);
    const file = safeProjectPath(root, '.tickets', `${uniqueId}.md`);
    const criteria = acceptanceCriteria.map((item) => `- [ ] ${String(item)}`).join('\n');
    const meta = [`id: ${uniqueId}`, ...(state ? [`state: ${state}`] : []), ...(parentId ? [`parentId: ${parentId}`, `parent: ${parentId}`] : []), ...(blockedBy.length ? ['blockedBy:', ...blockedBy.map((item) => `  - ${item}`)] : [])].join('\n');
    fs.writeFileSync(file, `---\n${meta}\n---\n# ${String(title || 'Untitled ticket').trim()}\n\n${String(objective).trim()}\n${criteria ? `\n## Acceptance criteria\n${criteria}\n` : ''}`, 'utf8');
    return parseTicket(file, fs.readFileSync(file, 'utf8'));
  }
  updateTicket(input) {
    this.assertPathInRoot(input.filePath);
    const ticket = this.resolveTicket(input.filePath);
    if (input.parentId !== undefined || input.parent !== undefined || input.blockedBy !== undefined) {
      const ids = new Set(this.listTickets().filter((item) => item.cwd === ticket.cwd && item.filePath !== ticket.filePath).map((item) => item.id.toLowerCase()));
      const parentId = input.parentId ?? input.parent;
      for (const ref of [parentId, ...(input.blockedBy || [])].filter(Boolean)) if (!ids.has(String(ref).toLowerCase())) throw new Error(`Ticket reference is not project-local: ${ref}`);
    }
    return updateTicketAtomic(ticket.filePath, input);
  }
  eligible(root) {
    const tickets = this.listTickets().filter((ticket) => ticket.cwd === path.resolve(root));
    const byId = new Map(); const duplicateIds = new Set(); tickets.forEach((ticket) => { const id = ticket.id.toLowerCase(); if (byId.has(id)) duplicateIds.add(id); else byId.set(id, ticket); }); const state = loadState(root);
    return tickets.find((ticket) => !ticket.duplicateId && !duplicateIds.has(ticket.id.toLowerCase()) && !ticket.issue && ['todo', 'idle'].includes(ticket.state) && !state.claims[claimKey(ticket)]?.status?.match(/running|claimed|retrying|needs_attention/) && !['pending_review', 'integration_pending', 'integrating', 'completing'].includes(state.claims[claimKey(ticket)]?.phase) && ticket.blockedBy.every((id) => byId.get(String(id).toLowerCase())?.state === 'done' || byId.get(String(id).toLowerCase())?.state === 'completed'));
  }
  dispatch(value, options = {}) { return this.startWorker(this.resolveTicket(value), options); }
  workspaceFor(ticket, workflow, expectedIntegration, reviewer = false) {
    if (workflow.workspaceMode !== 'worktree') return { cwd: ticket.cwd, branch: undefined, ticketPath: ticket.filePath };
    const workspace = path.join(ticket.cwd, '.orchestration', 'workspaces', `${sanitizeTicketId(ticket.id)}-${ticketHash(ticket.filePath)}`);
    const branch = `constellation/${sanitizeTicketId(ticket.id)}-${ticketHash(ticket.filePath)}`;
    const workspaceRoot = path.dirname(workspace);
    safeProjectPath(ticket.cwd, '.orchestration', 'workspaces');
    safeProjectPath(ticket.cwd, '.orchestration', 'workspaces', path.basename(workspace));
    fs.mkdirSync(workspaceRoot, { recursive: true });
    if (fs.existsSync(workspace) && fs.lstatSync(workspace).isSymbolicLink()) throw new Error('Refusing symlinked orchestration workspace.');
    if (!workflow.autoReview) throw new Error('Worktree mode requires autoReview=true; unreviewed output is never integrated.');
    if (!safeChildPath(ticket.cwd, path.dirname(workspace))) throw new Error('Workspace is outside project root.');
    // Preflight the registered destination before creating a child or worktree.
    const destination = preflight({ root: ticket.cwd, workspace: ticket.cwd, ticketPath: ticket.filePath, execFile: this.execFile });
    if (!fs.existsSync(workspace)) this.execFile('git', ['-C', ticket.cwd, 'worktree', 'add', '-b', branch, workspace, 'HEAD'], { stdio: 'ignore' });
    const ticketPath = path.join(workspace, path.relative(ticket.cwd, ticket.filePath));
    const captured = preflight({ root: ticket.cwd, workspace, sourceBranch: branch, ticketPath, execFile: this.execFile });
    if (reviewer && !expectedIntegration) throw new Error('Reviewer launch requires expected integration metadata.');
    if (reviewer && (!expectedIntegration.sourceHead || captured.sourceHead !== expectedIntegration.sourceHead)) throw new Error('Reviewed source HEAD moved before reviewer launch.');
    const preserved = expectedIntegration ? { ...expectedIntegration, sourceHead: reviewer ? expectedIntegration.sourceHead : captured.sourceHead, sourceTicketPath: ticketPath, phase: reviewer ? expectedIntegration.phase : 'correction' } : { ...captured, sourceBranch: branch, phase: 'dispatched' };
    return { cwd: workspace, branch, ticketPath, integration: preserved };
  }
  startWorker(ticket, { phase = 'worker', workflow = parseWorkflow(ticket.cwd), reviewer = false, allowAnyState = false, correctionFeedback = '', integration } = {}) {
    assertPiWorkflowModels(workflow);
    if (!this.roots.includes(path.resolve(ticket.cwd))) throw new Error('Ticket is not from a registered project root.');
    const current = this.listTickets().find((item) => item.filePath === ticket.filePath);
    if (!current) throw new Error('Ticket is not from a registered project root.');
    if (current.issue) throw new Error(current.issue);
    if (!allowAnyState && !['todo', 'idle', 'waiting'].includes(current.state)) throw new Error(`Ticket state is not dispatchable: ${current.state}`);
    ticket = { ...current, objective: correctionFeedback ? `${current.objective}\n\nReviewer feedback: ${correctionFeedback}` : current.objective };
    const rootState = loadState(ticket.cwd); const active = Object.values(rootState.claims || {}).filter((claim) => claim.status === 'running');
    if (active.length >= Math.min(3, workflow.maxConcurrent)) return { dispatched: false, reason: 'concurrency-cap', id: ticket.id };
    if ([...this.children.values()].some((entry) => entry.ticket?.filePath === ticket.filePath)) return { dispatched: false, running: true, id: ticket.id };
    const run = runId('pi', ticket.cwd);
    let workspace;
    try { workspace = this.workspaceFor(ticket, workflow, integration, reviewer); }
    catch (error) {
      if (workflow.workspaceMode === 'worktree') {
        const state = loadState(ticket.cwd); const now = new Date().toISOString();
        const attention = { runId: run, ticketId: ticket.id, ticketPath: ticket.filePath, phase: 'needs_attention', status: 'needs_attention', mode: 'worktree', error: `Worktree dispatch refused: ${error.message}`, startedAt: now, finishedAt: now };
        state.claims[claimKey(ticket)] = attention; state.runs[run] = attention; saveState(ticket.cwd, state); appendRun(ticket.cwd, { event: 'needs_attention', runId: run, ticketId: ticket.id, phase: 'dispatch', error: attention.error });
        this.runtimeStatuses.set(ticket.filePath, 'needs_attention');
      }
      throw error;
    }
    const ticketPath = workspace.ticketPath;
    const tools = reviewer ? 'read,bash,grep,find,ls' : 'read,bash,edit,write,grep,find,ls';
    const prompt = reviewer ? `Review ticket ${ticket.id} read-only at exact source HEAD ${workspace.integration?.sourceHead || 'captured source HEAD'}. Inspect only that checkout and its acceptance checklist. End with exactly REVIEW: PASS or REVIEW: CHANGES_REQUESTED.` : `Work on ticket ${ticket.id} at ${ticketPath}.\n\n${ticket.title}\n${ticket.objective}\n\nAcceptance checklist:\n${ticket.acceptanceCriteria.map((x) => `- [${x.completed ? 'x' : ' '}] ${x.text}`).join('\n')}\n\nRepository WORKFLOW instructions:\n${workflow.instructions}\n\nUse normal project files only; update/check off the source ticket at ${ticketPath}, and finish with a concise handoff. In worktree mode, commit all intended changes and set the ticket to done/completed with every acceptance criterion checked, leaving the worktree clean. Do not spawn recursive subagents.`;
    const model = reviewer ? workflow.reviewerModel : workflow.workerModel;
    const sessionDir = path.join(ticket.cwd, '.orchestration', 'sessions', `${sanitizeTicketId(ticket.id)}-${ticketHash(ticket.filePath)}`, reviewer ? 'reviewer' : 'worker');
    safeProjectPath(ticket.cwd, '.orchestration', 'sessions', path.basename(path.dirname(sessionDir)), path.basename(sessionDir));
    fs.mkdirSync(sessionDir, { recursive: true });
    const args = ['--mode', 'json', '--model', model, '--thinking', reviewer ? workflow.reviewerThinking : workflow.workerThinking, '--tools', tools, '--session-dir', sessionDir];
    if (fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).some((name) => name.endsWith('.jsonl') && fs.lstatSync(path.join(sessionDir, name)).isFile())) args.push('--continue');
    args.push('-p', prompt);
    const child = this.spawn('pi', args, { cwd: workspace.cwd, env: piChildEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const claimKeyValue = claimKey(ticket); const now = new Date().toISOString(); const claim = { runId: run, ticketId: ticket.id, ticketPath: ticket.filePath, workspaceTicketPath: ticketPath, parentTicketId: ticket.parentId || undefined, phase: reviewer ? 'reviewer' : phase, pid: child.pid, model, workspace: workspace.cwd, branch: workspace.branch, integration: workspace.integration, sessionDir, status: 'running', startedAt: now };
    rootState.claims[claimKeyValue] = claim; rootState.runs[run] = claim; rootState.attempts[claimKeyValue] = (rootState.attempts[claimKeyValue] || 0) + 1; saveState(ticket.cwd, rootState);
    this.children.set(run, { child, ticket, reviewer }); this.runtimeStatuses.set(ticket.filePath, reviewer ? 'reviewing' : 'running'); this.outputs.set(run, ''); appendRun(ticket.cwd, { event: 'started', runId: run, ticketId: ticket.id, phase: claim.phase, pid: child.pid, model, workspace: workspace.cwd, branch: workspace.branch });
    const output = (chunk) => { const text = String(chunk); this.outputs.set(run, `${this.outputs.get(run)}${text}`.slice(-30000)); appendRun(ticket.cwd, { event: 'output', runId: run, ticketId: ticket.id, phase: claim.phase, output: text.slice(-10000) }); };
    child.stdout?.on('data', output); child.stderr?.on('data', output); child.once('close', (code, signal) => this.finishWorker(ticket, run, code, signal, reviewer));
    return { dispatched: true, id: ticket.id, runId: run, filePath: ticket.filePath, pid: child.pid, phase: claim.phase };
  }
  readyAncestorPaths(ticketPath, currentIntegration, selected = new Set()) {
    const ticket = this.resolveTicket(ticketPath); const projectTickets = this.listTickets().filter((item) => item.cwd === ticket.cwd); const state = loadState(ticket.cwd); const requireIntegration = parseWorkflow(ticket.cwd).workspaceMode === 'worktree'; const ready = []; let parentId = ticket.parentId;
    while (parentId) { const matches = projectTickets.filter((item) => item.id.toLowerCase() === String(parentId).toLowerCase()); if (matches.length !== 1) break; const parent = matches[0]; const children = projectTickets.filter((item) => String(item.parentId || '').toLowerCase() === parent.id.toLowerCase());
      if (!children.length || children.some((item) => !['done', 'completed'].includes(item.state) && !(item.filePath === ticket.filePath && currentIntegration)) || children.some((item) => { const integration = state.claims[claimKey(item)]?.integration; return requireIntegration && integration?.phase !== 'integrated' && !selected.has(item.filePath) && !(item.filePath === ticket.filePath && currentIntegration); })) break;
      ready.push(parent); selected.add(parent.filePath); parentId = parent.parentId;
    }
    return ready;
  }
  completeIntegratedAncestors(root, ticketPath, currentIntegration) {
    const child = this.resolveTicket(ticketPath); if (!['done', 'completed'].includes(child.state)) updateTicketAtomic(child.filePath, { state: 'done' });
    const selected = new Set(); const parents = this.readyAncestorPaths(ticketPath, currentIntegration, selected); if (!parents.length) return {};
    const completionPaths = currentIntegration.completionPaths || parents.map((parent) => path.relative(root, parent.filePath));
    const expected = new Set(parents.map((parent) => path.relative(root, parent.filePath))); if (completionPaths.some((item) => !expected.has(item))) throw new Error('Persisted completion paths are no longer valid.');
    for (const parent of parents) updateTicketAtomic(parent.filePath, { state: 'done', acceptanceCriteria: parent.acceptanceCriteria.map((item) => ({ text: item.text, completed: true })) });
    this.execFile('git', ['-C', root, 'add', '--', ...completionPaths], { stdio: 'ignore' });
    this.execFile('git', ['-C', root, 'commit', '-m', 'chore: complete integrated Pi tickets', '--', ...completionPaths], { stdio: 'ignore' });
    const completionCommit = this.execFile('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const finalDestinationHead = completionCommit; appendRun(root, { event: 'parent-follow-up-committed', ticketId: ticketPath, paths: completionPaths, completionCommit, finalDestinationHead });
    return { completionPaths, completionCommit, finalDestinationHead };
  }
  completeReadyAncestors(ticket, integrated = false) {
    if (integrated) return this.completeIntegratedAncestors(ticket.cwd, ticket.filePath).completionCommit;
    const parents = this.readyAncestorPaths(ticket.filePath, { phase: 'integrated' });
    for (const parent of parents) { updateTicketAtomic(parent.filePath, { state: 'done', acceptanceCriteria: parent.acceptanceCriteria.map((item) => ({ text: item.text, completed: true })) }); this.runtimeStatuses.set(parent.filePath, 'done'); }
    return undefined;
  }
  finishWorker(ticket, runIdValue, code, signal, reviewer) {
    const entry = this.children.get(runIdValue); if (!entry) return; this.children.delete(runIdValue); const escalation = this.escalationTimers.get(runIdValue); if (escalation) { clearTimeout(escalation); this.escalationTimers.delete(runIdValue); }
    if (entry.interrupted) { const state = loadState(ticket.cwd); const claim = state.claims[claimKey(ticket)] || state.runs[runIdValue] || {}; claim.status = 'interrupted'; claim.pid = undefined; claim.finishedAt = new Date().toISOString(); claim.error = 'Run interrupted.'; state.claims[claimKey(ticket)] = claim; state.runs[runIdValue] = { ...state.runs[runIdValue], ...claim }; saveState(ticket.cwd, state); appendRun(ticket.cwd, { event: 'finished', runId: runIdValue, ticketId: ticket.id, phase: claim.phase, code, signal, status: 'interrupted', error: claim.error }); this.runtimeStatuses.set(ticket.filePath, 'waiting'); this.outputs.delete(runIdValue); return; }
    const state = loadState(ticket.cwd); const key = claimKey(ticket); const claim = state.claims[key] || state.runs[runIdValue] || {}; const output = this.outputs.get(runIdValue) || '';
    const passed = reviewer && /REVIEW:\s*PASS\b/i.test(output); const requested = reviewer && /REVIEW:\s*CHANGES_REQUESTED\b/i.test(output); const reviewStatus = reviewer ? (requested ? 'changes_requested' : (passed && code === 0 ? 'pass' : 'failed')) : undefined; const success = code === 0 && (!reviewer || (passed && !requested));
    const workflow = parseWorkflow(ticket.cwd); const attempts = state.attempts[key] || 1; const retryable = !success && attempts <= workflow.retryMax;
    claim.status = success ? 'completed' : (retryable ? 'retrying' : 'blocked'); if (reviewer) claim.reviewResult = { status: reviewStatus, timestamp: new Date().toISOString(), sourceHead: claim.integration?.sourceHead }; if (reviewer && claim.integration) claim.integration = { ...claim.integration, reviewResult: claim.reviewResult }; claim.finishedAt = new Date().toISOString(); claim.summary = output.slice(-2000); claim.error = success ? undefined : (reviewer && !passed ? 'Reviewer did not emit REVIEW: PASS.' : `Pi exited with code ${code}${signal ? ` (${signal})` : ''}`);
    state.claims[key] = claim; state.runs[runIdValue] = { ...state.runs[runIdValue], ...claim, status: claim.status }; saveState(ticket.cwd, state); appendRun(ticket.cwd, { event: 'finished', runId: runIdValue, ticketId: ticket.id, phase: claim.phase, code, signal, status: claim.status, summary: claim.summary, error: claim.error }); this.outputs.delete(runIdValue);
    if (success && !reviewer) {
      if (workflow.workspaceMode === 'worktree') {
        try { claim.integration = captureReviewed({ metadata: claim.integration, ticketPath: claim.workspaceTicketPath, execFile: this.execFile }); claim.reviewResult = { status: 'pending', timestamp: new Date().toISOString(), sourceHead: claim.integration.sourceHead }; claim.integration = { ...claim.integration, reviewResult: claim.reviewResult }; claim.phase = 'pending_review'; claim.status = 'completed'; state.claims[key] = claim; state.runs[runIdValue] = { ...state.runs[runIdValue], ...claim }; saveState(ticket.cwd, state); appendRun(ticket.cwd, { event: 'captured', runId: runIdValue, ticketId: ticket.id, sourceHead: claim.integration.sourceHead }); }
        catch (error) { claim.status = 'needs_attention'; claim.phase = 'needs_attention'; claim.error = `Worktree capture failed: ${error.message}`; state.claims[key] = claim; state.runs[runIdValue] = { ...state.runs[runIdValue], ...claim }; saveState(ticket.cwd, state); appendRun(ticket.cwd, { event: 'needs_attention', runId: runIdValue, ticketId: ticket.id, error: claim.error }); this.runtimeStatuses.set(ticket.filePath, 'needs_attention'); return; }
      }
      if (workflow.autoReview) { if (workflow.workspaceMode !== 'worktree') updateTicketAtomic(ticket.filePath, { state: 'review' }); this.runtimeStatuses.set(ticket.filePath, 'review'); this.startWorker(ticket, { workflow, reviewer: true, allowAnyState: true, integration: claim.integration }); } else { if (workflow.workspaceMode !== 'worktree') updateTicketAtomic(ticket.filePath, { state: 'done' }); this.runtimeStatuses.set(ticket.filePath, 'done'); this.completeReadyAncestors(ticket); }
    }
    else if (reviewer && success) {
      if (workflow.workspaceMode === 'worktree') {
        try {
          const priorIntegrations = Object.values(state.claims || {}).map((item) => item.integration).filter((item) => item && item.phase === 'integrated');
          claim.integration = { ...claim.integration, authorizedCommits: priorIntegrations };
          this.attemptIntegration(ticket.cwd, key, claim, state);
        }
        catch (error) {
          if (error.code === 'INTEGRATION_LOCK_BUSY') { claim.integration = { ...claim.integration, phase: 'integration_pending' }; claim.phase = 'integration_pending'; claim.status = 'completed'; state.claims[key] = claim; state.runs[runIdValue] = { ...state.runs[runIdValue], ...claim }; saveState(ticket.cwd, state); appendRun(ticket.cwd, { event: 'integration-deferred', runId: runIdValue, ticketId: ticket.id, error: error.message }); this.scheduleIntegrationRetry(ticket.cwd, key, runIdValue); return; } claim.integration = { ...claim.integration, error: error.message }; claim.status = 'needs_attention'; claim.phase = 'needs_attention'; claim.error = `Worktree integration failed: ${error.message}`; state.claims[key] = claim; state.runs[runIdValue] = { ...state.runs[runIdValue], ...claim }; saveState(ticket.cwd, state); appendRun(ticket.cwd, { event: 'needs_attention', runId: runIdValue, ticketId: ticket.id, error: claim.error }); this.runtimeStatuses.set(ticket.filePath, 'needs_attention'); return; }
      }
      if (workflow.workspaceMode !== 'worktree') updateTicketAtomic(ticket.filePath, { state: 'done' }); this.runtimeStatuses.set(ticket.filePath, 'done');
      // attemptIntegration performs merge, finalization, and parent completion
      // while holding the integration lock. Never run a second finalizer here.
      if (workflow.workspaceMode === 'worktree') return;
      this.completeReadyAncestors(ticket);
    }
    else if (reviewer && requested && retryable) { this.runtimeStatuses.set(ticket.filePath, 'retrying'); if (workflow.workspaceMode !== 'worktree') updateTicketAtomic(ticket.filePath, { state: 'todo' }); const feedback = assistantText(output).slice(0, 1200) || 'Reviewer requested changes.'; appendRun(ticket.cwd, { event: 'correction-requested', runId: runIdValue, ticketId: ticket.id, feedback }); this.startWorker(ticket, { workflow, phase: 'worker', allowAnyState: true, correctionFeedback: feedback, integration: claim.integration }); }
    else if (!retryable) { if (workflow.workspaceMode !== 'worktree') updateTicketAtomic(ticket.filePath, { state: 'blocked' }); this.runtimeStatuses.set(ticket.filePath, 'needs_attention'); }
    else {
      this.runtimeStatuses.set(ticket.filePath, 'retrying');
      const delay = 100 * (2 ** Math.min(4, attempts - 1));
      appendRun(ticket.cwd, { event: 'retry-scheduled', runId: runIdValue, ticketId: ticket.id, ticketPath: ticket.filePath, delayMs: delay, attempt: attempts });
      const retryKey = `${path.resolve(ticket.cwd)}|${ticket.filePath}`;
      const timer = setTimeout(() => {
        this.retryTimers.delete(retryKey);
        if (!this.roots.includes(path.resolve(ticket.cwd)) || [...this.children.values()].some((item) => item.ticket?.filePath === ticket.filePath)) return;
        let latest;
        try { latest = this.resolveTicket(ticket.filePath); } catch { return; }
        const latestState = loadState(latest.cwd);
        const claimState = latestState.claims[claimKey(latest)];
        if (claimState?.runId !== runIdValue || claimState.status !== 'retrying' || !['todo', 'idle', 'retrying'].includes(latest.state)) return;
        this.startWorker(latest, { workflow, reviewer, allowAnyState: true, integration: reviewer ? claimState?.integration : undefined });
      }, delay);
      timer.unref?.();
      this.retryTimers.set(retryKey, { timer, root: path.resolve(ticket.cwd), ticketPath: ticket.filePath, runId: runIdValue });
    }
  }
  markPendingRetryInterrupted(pending) {
    const state = loadState(pending.root);
    const claim = state.claims[path.resolve(pending.ticketPath)];
    if (claim?.runId === pending.runId) {
      claim.status = 'interrupted';
      claim.finishedAt = new Date().toISOString();
      state.runs[pending.runId] = { ...state.runs[pending.runId], ...claim, status: 'interrupted' };
      saveState(pending.root, state);
    }
  }
  stopQueueTimer(root) {
    const timer = this.queueTimers.get(root);
    if (timer) clearInterval(timer);
    this.queueTimers.delete(root);
  }
  dispatchNext(root) { const resolved = this.assertRoot(root); const workflow = parseWorkflow(resolved); const ticket = this.eligible(resolved); return ticket ? this.startWorker(ticket, { workflow }) : { dispatched: false, reason: 'no-eligible-ticket' }; }
  setScheduler(root, enabled) { this.assertRoot(root); const state = loadState(root); state.scheduler = { ...(state.scheduler || {}), enabled: Boolean(enabled), updatedAt: new Date().toISOString() }; saveState(root, state); return state.scheduler; }
  schedulerStatus(root) { const resolved = this.assertRoot(root); const state = loadState(resolved); return { ...state.scheduler, running: [...this.children.values()].filter((x) => (x.ticket?.cwd || x.root) === resolved).length }; }
  planObjective(root, objective) {
    const resolvedRoot = this.assertRoot(root); if (!String(objective || '').trim()) throw new Error('Planner objective must not be empty.'); const workflow = parseWorkflow(resolvedRoot); assertPiWorkflowModels(workflow); const id = runId('planner', resolvedRoot); const prompt = `Plan this objective for the repository at ${root}. You MUST return exactly one strict final JSON object and no other plan format: {"tickets":[{"id":"lowercase-safe-id","title":"...","objective":"...","acceptanceCriteria":["..."],"parentId":null,"blockedBy":[],"state":"planned"}]}. Return 2-50 tickets, exactly one root (parentId null, state planned), all children state todo, unique project-local IDs and refs. Do not write or modify any files (including tickets); only inspect. Objective: ${String(objective).trim()}`;
    const sessionDir = path.join(resolvedRoot, '.orchestration', 'sessions', `planner-${id}`); safeProjectPath(resolvedRoot, '.orchestration', 'sessions', `planner-${id}`); fs.mkdirSync(sessionDir, { recursive: true });
    const child = this.spawn('pi', ['--mode', 'json', '--model', workflow.plannerModel, '--thinking', workflow.plannerThinking, '--tools', 'read,grep,find,ls', '--session-dir', sessionDir, '-p', prompt], { cwd: resolvedRoot, env: piChildEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const state = loadState(resolvedRoot); const now = new Date().toISOString(); state.runs[id] = { runId: id, phase: 'planning', pid: child.pid, model: workflow.plannerModel, workspace: resolvedRoot, sessionDir, status: 'running', startedAt: now, objective: String(objective) }; saveState(resolvedRoot, state); this.children.set(id, { child, root: resolvedRoot, planner: true }); appendRun(resolvedRoot, { event: 'started', runId: id, phase: 'planning', pid: child.pid, model: workflow.plannerModel, workspace: root, objective: String(objective) });
    let plannerOutput = ''; const capture = (chunk) => { plannerOutput = `${plannerOutput}${String(chunk)}`.slice(-50000); appendRun(resolvedRoot, { event: 'output', runId: id, phase: 'planning', output: String(chunk).slice(-10000) }); }; child.stdout?.on('data', capture); child.stderr?.on('data', capture); child.once('close', (code, signal) => { const entry = this.children.get(id); this.children.delete(id); const latest = loadState(resolvedRoot); if (entry?.interrupted || latest.runs[id]?.status === 'interrupted') { appendRun(resolvedRoot, { event: 'finished', runId: id, phase: 'planning', code, signal, status: 'interrupted' }); return; } let planError; let plan;
      if (code === 0) { try { plan = extractPlannerPlan(plannerOutput); const existing = this.listTickets().filter((ticket) => ticket.cwd === resolvedRoot); const tickets = validatePlannerPlan(plan, existing); const created = []; try { for (const item of tickets) created.push(this.createTicket({ cwd: resolvedRoot, id: item.id, title: item.title, objective: item.objective, acceptanceCriteria: item.acceptanceCriteria, parentId: item.parentId, blockedBy: item.blockedBy, state: item.parentId ? 'todo' : 'planned', internalValidated: true })); } catch (error) { for (const item of created) { try { fs.unlinkSync(item.filePath); } catch {} } throw error; } } catch (error) { planError = `Planner output was invalid: ${error.message}`; } }
      else planError = `Planner exited with code ${code}${signal ? ` (${signal})` : ''}.`;
      latest.runs[id] = { ...latest.runs[id], status: code === 0 && !planError ? 'completed' : 'failed', code, signal, error: planError, finishedAt: new Date().toISOString() }; saveState(resolvedRoot, latest); appendRun(resolvedRoot, { event: 'finished', runId: id, phase: 'planning', code, signal, status: latest.runs[id].status, error: planError }); });
    return { started: true, runId: id, pid: child.pid, phase: 'planning' };
  }
  startQueue(root) { const resolved = this.assertRoot(root); const result = this.setScheduler(resolved, true); if (!this.queueTimers.has(resolved)) { const timer = setInterval(() => { try { if (loadState(resolved).scheduler?.enabled) this.dispatchNext(resolved); } catch (error) { appendRun(resolved, { event: 'scheduler-error', error: error.message }); } }, 1000); timer.unref?.(); this.queueTimers.set(resolved, timer); } return result; }
  stopQueue(root, persist = true) {
    const resolved = this.assertRoot(root);
    this.stopQueueTimer(resolved);
    return persist ? this.setScheduler(resolved, false) : undefined;
  }
  retry(value) {
    const text = String(value);
    for (const root of this.roots) {
      const run = loadState(root).runs?.[text];
      if (!run?.ticketPath) continue;
      const retryKey = `${root}|${run.ticketPath}`;
      const pending = this.retryTimers.get(retryKey);
      if (pending) { clearTimeout(pending.timer); this.retryTimers.delete(retryKey); }
      return this.startWorker(this.resolveTicket(run.ticketPath), { phase: run.phase === 'reviewer' ? 'worker' : run.phase, reviewer: run.phase === 'reviewer', allowAnyState: true });
    }
    return this.startWorker(this.resolveTicket(text), { allowAnyState: true });
  }
  async interrupt(value) {
    const text = String(value);
    const direct = this.children.get(text);
    if (direct) {
      direct.interrupted = true;
      const root = direct.root || direct.ticket?.cwd;
      if (root) {
        const state = loadState(root);
        const finishedAt = new Date().toISOString();
        if (state.runs[text]) state.runs[text] = { ...state.runs[text], status: 'interrupted', pid: undefined, finishedAt };
        if (direct.ticket && state.claims[claimKey(direct.ticket)]) state.claims[claimKey(direct.ticket)] = { ...state.claims[claimKey(direct.ticket)], status: 'interrupted', pid: undefined, finishedAt };
        saveState(root, state);
      }
      try {
        direct.child.kill('SIGTERM');
        const escalation = setTimeout(() => {
          this.escalationTimers.delete(text);
          if (this.children.has(text)) try { direct.child.kill('SIGKILL'); } catch {}
        }, 500);
        escalation.unref?.();
        this.escalationTimers.set(text, escalation);
      } catch {}
      return { interrupted: true, id: text };
    }
    const pendingByRun = [...this.retryTimers.entries()].find(([, pending]) => pending.runId === text);
    if (pendingByRun) {
      const [retryKey, pending] = pendingByRun;
      clearTimeout(pending.timer);
      this.retryTimers.delete(retryKey);
      this.markPendingRetryInterrupted(pending);
      this.runtimeStatuses.set(pending.ticketPath, 'waiting');
      return { interrupted: true, id: text };
    }
    const ticket = this.resolveTicket(text);
    const retryKey = `${path.resolve(ticket.cwd)}|${ticket.filePath}`;
    const pending = this.retryTimers.get(retryKey);
    if (pending) {
      clearTimeout(pending.timer);
      this.retryTimers.delete(retryKey);
      this.markPendingRetryInterrupted(pending);
      this.runtimeStatuses.set(ticket.filePath, 'waiting');
      return { interrupted: true, id: ticket.id };
    }
    const active = [...this.children.entries()].find(([, entry]) => entry.ticket?.filePath === ticket.filePath);
    return active ? this.interrupt(active[0]) : { interrupted: false, id: ticket.id };
  }
  close() {
    for (const timer of this.queueTimers.values()) clearInterval(timer);
    this.queueTimers.clear();
    for (const pending of this.retryTimers.values()) clearTimeout(pending.timer);
    this.retryTimers.clear();
    for (const pending of this.integrationRetryTimers.values()) clearTimeout(pending.timer);
    this.integrationRetryTimers.clear(); this.integrationRetryAttempts?.clear();
    for (const timer of this.escalationTimers.values()) clearTimeout(timer);
    this.escalationTimers.clear();
    const finishedAt = new Date().toISOString();
    for (const [id, entry] of this.children.entries()) {
      entry.interrupted = true;
      try { entry.child.kill('SIGTERM'); } catch {}
      const root = entry.root || entry.ticket?.cwd;
      if (root) {
        const state = loadState(root);
        if (state.runs[id]?.status === 'running' || (entry.ticket && state.claims[claimKey(entry.ticket)]?.status === 'running')) {
          state.runs[id] = { ...state.runs[id], status: 'interrupted', pid: undefined, finishedAt, error: 'Orchestration provider closed.' };
          if (entry.ticket && state.claims[claimKey(entry.ticket)]) state.claims[claimKey(entry.ticket)] = { ...state.claims[claimKey(entry.ticket)], status: 'interrupted', pid: undefined, finishedAt, error: 'Orchestration provider closed.' };
          saveState(root, state);
          appendRun(root, { event: 'finished', runId: id, phase: state.runs[id].phase, status: 'interrupted', error: state.runs[id].error });
        }
      }
    }
    this.children.clear();
  }
}
module.exports = { PiMarkdownProvider, parseMarkdown: parseTicket, walkTickets, sanitizeTicketId, canonicalRoot, assistantText, extractPlannerPlan, validatePlannerPlan, safeChildPath };
