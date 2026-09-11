const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn: spawnProcess, execFileSync } = require('node:child_process');
const { parseTicket, updateTicketAtomic } = require('./tickets.cjs');
const { parseWorkflow, PI_WORKFLOW_MODELS } = require('./workflow.cjs');
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
  constructor({ roots = [], spawn = spawnProcess, execFile = execFileSync } = {}) {
    this.roots = [...new Set(roots.map(canonicalRoot))];
    this.spawn = spawn;
    this.execFile = execFile;
    this.children = new Map();
    this.outputs = new Map();
    this.queueTimers = new Map();
    this.runtimeStatuses = new Map();
    this.retryTimers = new Map();
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
      for (const [key, pending] of this.retryTimers) {
        if (pending.root !== root) continue;
        clearTimeout(pending.timer);
        this.retryTimers.delete(key);
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
    const liveRetries = new Set([...this.retryTimers.values()].map((pending) => pending.runId));
    for (const root of this.roots) reconcileState(root, loadState(root), live, liveRetries);
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
      return status ? { ...ticket, status, state: status } : ticket;
    });
  }
  runSnapshot(root) {
    const state = loadState(root);
    return Object.values(state.runs || {}).map((run) => ({
      runId: run.runId, ticketId: run.ticketId, parentTicketId: run.parentTicketId, phase: run.phase, status: run.status,
      cwd: run.workspace || run.cwd, projectRoot: root, model: run.model, workspace: run.workspace, branch: run.branch,
      startedAt: run.startedAt, finishedAt: run.finishedAt, summary: run.summary, objective: run.objective,
      code: run.code, signal: run.signal, error: run.error, ticketPath: run.ticketPath, sessionDir: run.sessionDir,
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
      return { provider: 'pi', threadId: runId, status: run.status, phase: run.phase, model: run.model, workspace: run.workspace, branch: run.branch, summary: run.summary, error: run.error, items };
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
    return tickets.find((ticket) => !ticket.duplicateId && !duplicateIds.has(ticket.id.toLowerCase()) && !ticket.issue && ['todo', 'idle'].includes(ticket.state) && !state.claims[claimKey(ticket)]?.status?.match(/running|claimed|retrying/) && ticket.blockedBy.every((id) => byId.get(String(id).toLowerCase())?.state === 'done' || byId.get(String(id).toLowerCase())?.state === 'completed'));
  }
  dispatch(value, options = {}) { return this.startWorker(this.resolveTicket(value), options); }
  workspaceFor(ticket, workflow) {
    if (workflow.workspaceMode !== 'worktree') return { cwd: ticket.cwd, branch: undefined };
    const workspace = path.join(ticket.cwd, '.orchestration', 'workspaces', `${sanitizeTicketId(ticket.id)}-${ticketHash(ticket.filePath)}`);
    const branch = `constellation/${sanitizeTicketId(ticket.id)}-${ticketHash(ticket.filePath)}`;
    try {
      this.execFile('git', ['-C', ticket.cwd, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' });
      const workspaceRoot = path.dirname(workspace);
      safeProjectPath(ticket.cwd, '.orchestration', 'workspaces');
      safeProjectPath(ticket.cwd, '.orchestration', 'workspaces', path.basename(workspace));
      fs.mkdirSync(workspaceRoot, { recursive: true });
      if (fs.existsSync(workspace) && fs.lstatSync(workspace).isSymbolicLink()) throw new Error('Refusing symlinked orchestration workspace.');
      if (!safeChildPath(ticket.cwd, path.dirname(workspace))) throw new Error('Workspace is outside project root.');
      if (!fs.existsSync(workspace)) {
        try { this.execFile('git', ['-C', ticket.cwd, 'worktree', 'add', '-b', branch, workspace, 'HEAD'], { stdio: 'ignore' }); }
        catch { this.execFile('git', ['-C', ticket.cwd, 'worktree', 'add', workspace, branch], { stdio: 'ignore' }); }
      }
      return { cwd: workspace, branch };
    } catch (error) {
      if (/symlinked|outside project root/.test(error.message)) throw error;
      appendRun(ticket.cwd, { event: 'workspace-fallback', ticketId: ticket.id, error: `Could not create worktree; using project root. Check git status and permissions: ${error.message}` });
      return { cwd: ticket.cwd, branch: undefined, error: error.message };
    }
  }
  startWorker(ticket, { phase = 'worker', workflow = parseWorkflow(ticket.cwd), reviewer = false, allowAnyState = false, correctionFeedback = '' } = {}) {
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
    const run = runId('pi', ticket.cwd); const workspace = this.workspaceFor(ticket, workflow);
    const tools = reviewer ? 'read,bash,grep,find,ls' : 'read,bash,edit,write,grep,find,ls';
    const prompt = reviewer ? `Review ticket ${ticket.id} read-only. Inspect changes and acceptance checklist. End with exactly REVIEW: PASS or REVIEW: CHANGES_REQUESTED.` : `Work on ticket ${ticket.id} at ${ticket.filePath}.\n\n${ticket.title}\n${ticket.objective}\n\nAcceptance checklist:\n${ticket.acceptanceCriteria.map((x) => `- [${x.completed ? 'x' : ' '}] ${x.text}`).join('\n')}\n\nRepository WORKFLOW instructions:\n${workflow.instructions}\n\nUse normal project files only; update/check off the source ticket at ${ticket.filePath}, and finish with a concise handoff. Do not spawn recursive subagents.`;
    const model = reviewer ? workflow.reviewerModel : workflow.workerModel;
    const sessionDir = path.join(ticket.cwd, '.orchestration', 'sessions', `${sanitizeTicketId(ticket.id)}-${ticketHash(ticket.filePath)}`, reviewer ? 'reviewer' : 'worker');
    safeProjectPath(ticket.cwd, '.orchestration', 'sessions', path.basename(path.dirname(sessionDir)), path.basename(sessionDir));
    fs.mkdirSync(sessionDir, { recursive: true });
    const args = ['--mode', 'json', '--model', model, '--thinking', reviewer ? workflow.reviewerThinking : workflow.workerThinking, '--tools', tools, '--session-dir', sessionDir];
    if (fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).some((name) => name.endsWith('.jsonl') && fs.lstatSync(path.join(sessionDir, name)).isFile())) args.push('--continue');
    args.push('-p', prompt);
    const child = this.spawn('pi', args, { cwd: workspace.cwd, env: piChildEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const claimKeyValue = claimKey(ticket); const now = new Date().toISOString(); const claim = { runId: run, ticketId: ticket.id, ticketPath: ticket.filePath, parentTicketId: ticket.parentId || undefined, phase: reviewer ? 'reviewer' : phase, pid: child.pid, model, workspace: workspace.cwd, branch: workspace.branch, sessionDir, status: 'running', startedAt: now };
    rootState.claims[claimKeyValue] = claim; rootState.runs[run] = claim; rootState.attempts[claimKeyValue] = (rootState.attempts[claimKeyValue] || 0) + 1; saveState(ticket.cwd, rootState);
    this.children.set(run, { child, ticket, reviewer }); this.runtimeStatuses.set(ticket.filePath, reviewer ? 'reviewing' : 'running'); this.outputs.set(run, ''); appendRun(ticket.cwd, { event: 'started', runId: run, ticketId: ticket.id, phase: claim.phase, pid: child.pid, model, workspace: workspace.cwd, branch: workspace.branch });
    const output = (chunk) => { const text = String(chunk); this.outputs.set(run, `${this.outputs.get(run)}${text}`.slice(-30000)); appendRun(ticket.cwd, { event: 'output', runId: run, ticketId: ticket.id, phase: claim.phase, output: text.slice(-10000) }); };
    child.stdout?.on('data', output); child.stderr?.on('data', output); child.once('close', (code, signal) => this.finishWorker(ticket, run, code, signal, reviewer));
    return { dispatched: true, id: ticket.id, runId: run, filePath: ticket.filePath, pid: child.pid, phase: claim.phase };
  }
  completeReadyAncestors(ticket) {
    let parentId = ticket.parentId;
    while (parentId) {
      const projectTickets = this.listTickets().filter((item) => item.cwd === ticket.cwd);
      const matches = projectTickets.filter((item) => item.id.toLowerCase() === String(parentId).toLowerCase());
      if (matches.length !== 1) return;
      const parent = matches[0];
      const children = projectTickets.filter((item) => String(item.parentId || '').toLowerCase() === parent.id.toLowerCase());
      if (!children.length || children.some((item) => !['done', 'completed'].includes(item.state))) return;
      const criteria = parent.acceptanceCriteria.map((item) => ({ text: item.text, completed: true }));
      updateTicketAtomic(parent.filePath, { state: 'done', acceptanceCriteria: criteria });
      this.runtimeStatuses.set(parent.filePath, 'done');
      appendRun(ticket.cwd, { event: 'parent-completed', ticketId: parent.id, triggerTicketId: ticket.id });
      parentId = parent.parentId;
    }
  }
  finishWorker(ticket, runIdValue, code, signal, reviewer) {
    const entry = this.children.get(runIdValue); if (!entry) return; this.children.delete(runIdValue); const escalation = this.escalationTimers.get(runIdValue); if (escalation) { clearTimeout(escalation); this.escalationTimers.delete(runIdValue); }
    if (entry.interrupted) { const state = loadState(ticket.cwd); const claim = state.claims[claimKey(ticket)] || state.runs[runIdValue] || {}; claim.status = 'interrupted'; claim.finishedAt = new Date().toISOString(); claim.error = 'Run interrupted.'; state.claims[claimKey(ticket)] = claim; state.runs[runIdValue] = { ...state.runs[runIdValue], ...claim }; saveState(ticket.cwd, state); appendRun(ticket.cwd, { event: 'finished', runId: runIdValue, ticketId: ticket.id, phase: claim.phase, code, signal, status: 'interrupted', error: claim.error }); this.runtimeStatuses.set(ticket.filePath, 'waiting'); this.outputs.delete(runIdValue); return; }
    const state = loadState(ticket.cwd); const key = claimKey(ticket); const claim = state.claims[key] || state.runs[runIdValue] || {}; const output = this.outputs.get(runIdValue) || '';
    const passed = reviewer && /REVIEW:\s*PASS\b/i.test(output); const requested = reviewer && /REVIEW:\s*CHANGES_REQUESTED\b/i.test(output); const success = code === 0 && (!reviewer || (passed && !requested));
    const workflow = parseWorkflow(ticket.cwd); const attempts = state.attempts[key] || 1; const retryable = !success && attempts <= workflow.retryMax;
    claim.status = success ? 'completed' : (retryable ? 'retrying' : 'blocked'); claim.finishedAt = new Date().toISOString(); claim.summary = output.slice(-2000); claim.error = success ? undefined : (reviewer && !passed ? 'Reviewer did not emit REVIEW: PASS.' : `Pi exited with code ${code}${signal ? ` (${signal})` : ''}`);
    state.claims[key] = claim; state.runs[runIdValue] = { ...state.runs[runIdValue], ...claim, status: claim.status }; saveState(ticket.cwd, state); appendRun(ticket.cwd, { event: 'finished', runId: runIdValue, ticketId: ticket.id, phase: claim.phase, code, signal, status: claim.status, summary: claim.summary, error: claim.error }); this.outputs.delete(runIdValue);
    if (success && !reviewer) { if (workflow.autoReview) { updateTicketAtomic(ticket.filePath, { state: 'review' }); this.runtimeStatuses.set(ticket.filePath, 'review'); this.startWorker(ticket, { workflow, reviewer: true, allowAnyState: true }); } else { updateTicketAtomic(ticket.filePath, { state: 'done' }); this.runtimeStatuses.set(ticket.filePath, 'done'); this.completeReadyAncestors(ticket); } }
    else if (reviewer && success) { updateTicketAtomic(ticket.filePath, { state: 'done' }); this.runtimeStatuses.set(ticket.filePath, 'done'); this.completeReadyAncestors(ticket); }
    else if (reviewer && requested && retryable) { this.runtimeStatuses.set(ticket.filePath, 'retrying'); updateTicketAtomic(ticket.filePath, { state: 'todo' }); const feedback = assistantText(output).slice(0, 1200) || 'Reviewer requested changes.'; appendRun(ticket.cwd, { event: 'correction-requested', runId: runIdValue, ticketId: ticket.id, feedback }); this.startWorker(ticket, { workflow, phase: 'worker', allowAnyState: true, correctionFeedback: feedback }); }
    else if (!retryable) { updateTicketAtomic(ticket.filePath, { state: 'blocked' }); this.runtimeStatuses.set(ticket.filePath, 'needs_attention'); }
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
        this.startWorker(latest, { workflow, reviewer, allowAnyState: true });
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
        if (state.runs[text]) state.runs[text] = { ...state.runs[text], status: 'interrupted', finishedAt };
        if (direct.ticket && state.claims[claimKey(direct.ticket)]) state.claims[claimKey(direct.ticket)] = { ...state.claims[claimKey(direct.ticket)], status: 'interrupted', finishedAt };
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
          state.runs[id] = { ...state.runs[id], status: 'interrupted', finishedAt, error: 'Orchestration provider closed.' };
          if (entry.ticket && state.claims[claimKey(entry.ticket)]) state.claims[claimKey(entry.ticket)] = { ...state.claims[claimKey(entry.ticket)], status: 'interrupted', finishedAt, error: 'Orchestration provider closed.' };
          saveState(root, state);
          appendRun(root, { event: 'finished', runId: id, phase: state.runs[id].phase, status: 'interrupted', error: state.runs[id].error });
        }
      }
    }
    this.children.clear();
  }
}
module.exports = { PiMarkdownProvider, parseMarkdown: parseTicket, walkTickets, sanitizeTicketId, canonicalRoot, assistantText, extractPlannerPlan, validatePlannerPlan, safeChildPath };
