const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PiMarkdownProvider, parseMarkdown, walkTickets } = require('./provider.cjs');
const { appendRun, loadState, saveState } = require('./state.cjs');

function tempProject() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-pi-')));
}

function writeWorkflow(root, values = {}) {
  fs.writeFileSync(path.join(root, 'WORKFLOW.md'), `---\nmaxConcurrent: ${values.maxConcurrent ?? 2}\nautoReview: ${values.autoReview ?? false}\nworkspaceMode: ${values.workspaceMode ?? 'root'}\nretryMax: ${values.retryMax ?? 0}\n---\n${values.instructions ?? 'Follow the ticket.'}\n`, 'utf8');
}

function writeTicket(root, id, { state = 'todo', parentId, blockedBy = [], title = id } = {}) {
  const dir = path.join(root, '.tickets');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}-${Math.random().toString(36).slice(2, 7)}.md`);
  fs.writeFileSync(filePath, `---\nid: ${id}\nstate: ${state}\n${parentId ? `parentId: ${parentId}\n` : ''}${blockedBy.length ? `blockedBy:\n${blockedBy.map((item) => `  - ${item}`).join('\n')}\n` : ''}---\n# ${title}\n\nDo ${title}.\n\n## Acceptance criteria\n\n- [ ] Complete ${title}\n`, 'utf8');
  return filePath;
}

function fakeSpawn() {
  const calls = [];
  let nextPid = 4100;
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kills = [];
    child.kill = (signal) => { child.kills.push(signal); return true; };
    calls.push({ command, args, options, child });
    return child;
  };
  return { calls, spawn };
}

function assistantEvent(value) {
  return `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }] } })}\n`;
}

function closeCall(call, code = 0, signal = null) {
  call.child.emit('close', code, signal);
}

function argValue(call, name) {
  const index = call.args.indexOf(name);
  return index >= 0 ? call.args[index + 1] : undefined;
}

test('discovers only markdown tickets under .tickets and parses frontmatter/checklist progress', () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, 'WORKFLOW.md'), '# Workflow\n', 'utf8');
  fs.mkdirSync(path.join(root, '.tickets', 'TODO'), { recursive: true });
  const ticketPath = path.join(root, '.tickets', 'TODO', 'PI-1.md');
  fs.writeFileSync(ticketPath, `---\nid: PI-1\ntitle: Add Pi tickets\nstate: in_progress\npriority: 2\nlabels:\n  - orchestration\n  - pi\n---\n\n## Description\n\nWire markdown tickets into Constellation.\n\n## Acceptance Criteria\n\n- [x] Parse frontmatter\n- [ ] Show progress\n`, 'utf8');

  assert.deepEqual(walkTickets(root), [ticketPath]);
  const ticket = parseMarkdown(ticketPath, fs.readFileSync(ticketPath, 'utf8'));
  assert.equal(ticket.id, 'PI-1');
  assert.equal(ticket.title, 'Add Pi tickets');
  assert.equal(ticket.status, 'in_progress');
  assert.equal(ticket.cwd, root);
  assert.deepEqual(ticket.labels, ['orchestration', 'pi']);
  assert.deepEqual(ticket.acceptanceCriteria.map((item) => item.completed), [true, false]);
});

test('Pi ticket edits preserve completed acceptance criteria', () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, '.tickets'));
  const ticketPath = path.join(root, '.tickets', 'PI-EDIT.md');
  fs.writeFileSync(ticketPath, '# Edit me\n\n## Acceptance criteria\n\n- [x] Keep this complete\n- [ ] Finish this later\n', 'utf8');
  const provider = new PiMarkdownProvider({ roots: [root] });
  const updated = provider.updateTicket({ filePath: ticketPath, title: 'Edited', objective: 'Updated objective', acceptanceCriteria: ['Keep this complete', 'Finish this later'] });
  assert.deepEqual(updated.acceptanceCriteria.map((item) => item.completed), [true, false]);
  assert.match(fs.readFileSync(ticketPath, 'utf8'), /- \[x\] Keep this complete/);
  provider.close();
});

test('readRun parses multiple JSONL events', () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, '.orchestration'), { recursive: true });
  const provider = new PiMarkdownProvider({ roots: [root] });
  const state = loadState(root);
  state.runs['run-1'] = { runId: 'run-1', status: 'running', phase: 'worker', model: 'test', workspace: root };
  saveState(root, state);
  fs.writeFileSync(path.join(root, '.orchestration', 'runs.jsonl'), [
    { runId: 'run-1', event: 'started', phase: 'worker' },
    { runId: 'other', event: 'output' },
    { runId: 'run-1', event: 'output', output: 'second event' },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');
  assert.deepEqual(provider.readRun('run-1').items.map((item) => item.event), ['started', 'output']);
  provider.close();
});

test('every public root operation rejects unregistered roots', () => {
  const root = tempProject();
  const outside = tempProject();
  const provider = new PiMarkdownProvider({ roots: [root] });
  assert.throws(() => provider.createTicket({ cwd: outside, title: 'No' }), /not registered/i);
  assert.throws(() => provider.planObjective(outside, 'No'), /not registered/i);
  assert.throws(() => provider.dispatchNext(outside), /not registered/i);
  assert.throws(() => provider.startQueue(outside), /not registered/i);
  assert.throws(() => provider.stopQueue(outside), /not registered/i);
  assert.throws(() => provider.schedulerStatus(outside), /not registered/i);
  provider.close();
});

test('planner uses Sol read-only tools and atomically creates one planned parent with todo children', () => {
  const root = tempProject();
  writeWorkflow(root);
  const fake = fakeSpawn();
  const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn });
  const started = provider.planObjective(root, 'Ship bounded orchestration');
  const call = fake.calls[0];
  assert.equal(argValue(call, '--model'), 'openai-codex/gpt-5.6-sol');
  assert.equal(argValue(call, '--thinking'), 'xhigh');
  assert.equal(argValue(call, '--tools'), 'read,grep,find,ls');
  assert.match(argValue(call, '--session-dir'), /planner-planner-/);
  const plan = { tickets: [
    { id: 'objective', title: 'Ship orchestration', objective: 'Coordinate the work.', acceptanceCriteria: ['All children complete'], parentId: null, blockedBy: [], state: 'planned' },
    { id: 'build-core', title: 'Build core', objective: 'Implement core.', acceptanceCriteria: ['Tests pass'], parentId: 'objective', blockedBy: [], state: 'todo' },
    { id: 'review-core', title: 'Review core', objective: 'Review core.', acceptanceCriteria: ['Review passes'], parentId: 'objective', blockedBy: ['build-core'], state: 'todo' },
  ] };
  call.child.stdout.emit('data', assistantEvent(plan));
  closeCall(call);

  const tickets = provider.listTickets();
  assert.deepEqual(tickets.map((ticket) => [ticket.id, ticket.state]).sort(), [['build-core', 'todo'], ['objective', 'planned'], ['review-core', 'todo']]);
  assert.equal(loadState(root).runs[started.runId].status, 'completed');
  provider.close();
});

test('Pi children get a copied environment without OPENAI_API_KEY', () => {
  const root = tempProject();
  writeWorkflow(root, { autoReview: false });
  const ticketPath = writeTicket(root, 'env-check');
  const fake = fakeSpawn();
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'must-not-leak';
  try {
    const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn });
    provider.planObjective(root, 'Check environment');
    assert.equal(fake.calls[0].options.env.OPENAI_API_KEY, undefined);
    assert.equal(fake.calls[0].options.env.PATH, process.env.PATH);
    provider.dispatch(ticketPath);
    assert.equal(fake.calls[1].options.env.OPENAI_API_KEY, undefined);
    assert.equal(process.env.OPENAI_API_KEY, 'must-not-leak');
    provider.close();
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('invalid planner output fails without partially creating tickets', () => {
  const root = tempProject();
  writeWorkflow(root);
  const fake = fakeSpawn();
  const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn });
  const started = provider.planObjective(root, 'Invalid plan');
  fake.calls[0].child.stdout.emit('data', assistantEvent({ tickets: [
    { id: 'only-root', title: 'Root', objective: '', acceptanceCriteria: ['Okay'], parentId: null, blockedBy: [], state: 'planned' },
    { id: 'bad child', title: 'Bad', objective: '', acceptanceCriteria: ['Okay'], parentId: 'only-root', blockedBy: [], state: 'todo' },
  ] }));
  closeCall(fake.calls[0]);
  assert.equal(provider.listTickets().length, 0);
  assert.equal(loadState(root).runs[started.runId].status, 'failed');
  assert.match(loadState(root).runs[started.runId].error, /invalid/i);
  provider.close();
});

test('worker uses Luna explicit tools and only continues a real ticket-specific JSONL session', () => {
  const root = tempProject();
  writeWorkflow(root, { autoReview: false });
  const ticketPath = writeTicket(root, 'worker-one');
  const fake = fakeSpawn();
  const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn });
  const first = provider.dispatch(ticketPath);
  assert.equal(argValue(fake.calls[0], '--model'), 'openai-codex/gpt-5.6-luna');
  assert.equal(argValue(fake.calls[0], '--thinking'), 'medium');
  assert.equal(argValue(fake.calls[0], '--tools'), 'read,bash,edit,write,grep,find,ls');
  const sessionDir = argValue(fake.calls[0], '--session-dir');
  assert.match(sessionDir, /worker-one-[a-f0-9]{10}[\\/]worker$/);
  assert.equal(fake.calls[0].args.includes('--continue'), false);
  fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), '{}\n');
  closeCall(fake.calls[0]);
  assert.equal(provider.resolveTicket(ticketPath).state, 'done');

  provider.retry(first.runId);
  assert.equal(fake.calls[1].args.includes('--continue'), true);
  assert.equal(argValue(fake.calls[1], '--session-dir'), sessionDir);
  provider.close();
});

test('historical retry uses canonical ticketPath when human IDs collide across projects', () => {
  const firstRoot = tempProject();
  const secondRoot = tempProject();
  writeWorkflow(firstRoot, { autoReview: false });
  writeWorkflow(secondRoot, { autoReview: false });
  writeTicket(firstRoot, 'same-id');
  const targetPath = writeTicket(secondRoot, 'same-id');
  const fake = fakeSpawn();
  const provider = new PiMarkdownProvider({ roots: [firstRoot, secondRoot], spawn: fake.spawn });
  const started = provider.dispatch(targetPath);
  closeCall(fake.calls[0]);
  provider.retry(started.runId);
  assert.equal(fake.calls[1].options.cwd, secondRoot);
  assert.equal(loadState(secondRoot).runs[started.runId].ticketPath, targetPath);
  provider.close();
});

test('planner and three workers coexist without child-shape crashes and snapshot live counts are scoped', () => {
  const root = tempProject();
  const other = tempProject();
  writeWorkflow(root, { maxConcurrent: 9, autoReview: false });
  writeWorkflow(other);
  const files = [1, 2, 3, 4].map((number) => writeTicket(root, `cap-${number}`));
  const fake = fakeSpawn();
  const provider = new PiMarkdownProvider({ roots: [root, other], spawn: fake.spawn });
  const planner = provider.planObjective(root, 'Keep planning');
  assert.equal(provider.dispatch(files[0]).dispatched, true);
  assert.equal(provider.dispatch(files[1]).dispatched, true);
  assert.equal(provider.dispatch(files[2]).dispatched, true);
  assert.equal(provider.dispatch(files[3]).reason, 'concurrency-cap');
  const snapshot = provider.snapshot();
  assert.equal(snapshot.scheduler.projects.find((project) => project.root === root).running, 4);
  assert.equal(snapshot.scheduler.projects.find((project) => project.root === other).running, 0);
  assert.equal(snapshot.runs.find((run) => run.runId === planner.runId).objective, 'Keep planning');
  provider.close();
});

test('interrupt persists worker run and claim status and sends SIGTERM', async () => {
  const root = tempProject();
  writeWorkflow(root);
  const ticketPath = writeTicket(root, 'interrupt-me');
  const fake = fakeSpawn();
  const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn });
  const started = provider.dispatch(ticketPath);
  await provider.interrupt(started.runId);
  let state = loadState(root);
  assert.equal(state.runs[started.runId].status, 'interrupted');
  assert.equal(state.claims[ticketPath].status, 'interrupted');
  assert.deepEqual(fake.calls[0].child.kills, ['SIGTERM']);
  closeCall(fake.calls[0], null, 'SIGTERM');
  state = loadState(root);
  assert.equal(state.runs[started.runId].status, 'interrupted');
  assert.equal(provider.resolveTicket(ticketPath).status, 'waiting');
  provider.close();
});

test('interrupting a pending retry cancels it and marks both run and claim interrupted', async () => {
  const root = tempProject();
  writeWorkflow(root, { retryMax: 2 });
  const ticketPath = writeTicket(root, 'retrying');
  const fake = fakeSpawn();
  const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn });
  const started = provider.dispatch(ticketPath);
  closeCall(fake.calls[0], 1);
  assert.equal(provider.retryTimers.size, 1);
  provider.updateRoots([root]);
  assert.equal(loadState(root).claims[ticketPath].status, 'retrying');
  await provider.interrupt(started.runId);
  const state = loadState(root);
  assert.equal(provider.retryTimers.size, 0);
  assert.equal(state.claims[ticketPath].status, 'interrupted');
  assert.equal(state.runs[started.runId].status, 'interrupted');
  provider.close();
});

test('restart reconciliation makes orphaned retry claims eligible again', () => {
  const root = tempProject();
  writeWorkflow(root);
  const ticketPath = writeTicket(root, 'orphaned-retry');
  const state = loadState(root);
  state.claims[ticketPath] = { runId: 'old-retry', ticketId: 'orphaned-retry', ticketPath, phase: 'worker', status: 'retrying' };
  state.runs['old-retry'] = { ...state.claims[ticketPath] };
  saveState(root, state);
  const provider = new PiMarkdownProvider({ roots: [root] });
  assert.equal(loadState(root).claims[ticketPath].status, 'stale');
  assert.equal(loadState(root).runs['old-retry'].status, 'stale');
  assert.equal(provider.eligible(root).filePath, ticketPath);
  provider.close();
});

test('planner interruption persists and pausing a queue does not kill active work', async () => {
  const root = tempProject();
  writeWorkflow(root);
  const ticketPath = writeTicket(root, 'active-on-pause');
  const fake = fakeSpawn();
  const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn });
  const planner = provider.planObjective(root, 'Interrupt this planner');
  await provider.interrupt(planner.runId);
  assert.equal(loadState(root).runs[planner.runId].status, 'interrupted');
  assert.deepEqual(fake.calls[0].child.kills, ['SIGTERM']);

  const worker = provider.dispatch(ticketPath);
  provider.startQueue(root);
  provider.stopQueue(root);
  assert.equal(provider.children.has(worker.runId), true);
  assert.deepEqual(fake.calls[1].child.kills, []);
  provider.close();
});

test('removing a root interrupts its children and excludes it from scheduler snapshots', () => {
  const root = tempProject();
  const retained = tempProject();
  writeWorkflow(root);
  writeWorkflow(retained);
  const ticketPath = writeTicket(root, 'removed-root');
  const fake = fakeSpawn();
  const provider = new PiMarkdownProvider({ roots: [root, retained], spawn: fake.spawn });
  const worker = provider.dispatch(ticketPath);
  provider.updateRoots([retained]);
  assert.equal(loadState(root).runs[worker.runId].status, 'interrupted');
  assert.deepEqual(provider.snapshot().projects, [retained]);
  assert.deepEqual(fake.calls[0].child.kills, ['SIGTERM']);
  provider.close();
});

test('generated IDs avoid existing frontmatter IDs even when filenames differ', () => {
  const root = tempProject();
  writeWorkflow(root);
  writeTicket(root, 'same-title', { title: 'Existing' });
  const provider = new PiMarkdownProvider({ roots: [root] });
  const created = provider.createTicket({ cwd: root, title: 'Same title' });
  assert.equal(created.id, 'same-title-2');
  assert.throws(() => provider.createTicket({ cwd: root, id: 'SAME-TITLE', title: 'Explicit duplicate' }), /already exists/i);
  provider.close();
});

test('auto-review passes tickets and changes requested launch a correction worker', () => {
  const root = tempProject();
  writeWorkflow(root, { autoReview: true, retryMax: 4 });
  const passPath = writeTicket(root, 'review-pass');
  const correctionPath = writeTicket(root, 'review-change');
  const fake = fakeSpawn();
  const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn });

  provider.dispatch(passPath);
  closeCall(fake.calls[0]);
  assert.equal(argValue(fake.calls[1], '--model'), 'openai-codex/gpt-5.6-luna');
  assert.equal(argValue(fake.calls[1], '--tools'), 'read,bash,grep,find,ls');
  fake.calls[1].child.stdout.emit('data', assistantEvent('REVIEW: PASS'));
  closeCall(fake.calls[1]);
  assert.equal(provider.resolveTicket(passPath).state, 'done');

  provider.dispatch(correctionPath);
  closeCall(fake.calls[2]);
  fake.calls[3].child.stdout.emit('data', assistantEvent('REVIEW: CHANGES_REQUESTED\nAdd the missing test.'));
  closeCall(fake.calls[3]);
  assert.equal(argValue(fake.calls[4], '--model'), 'openai-codex/gpt-5.6-luna');
  assert.equal(argValue(fake.calls[4], '--tools'), 'read,bash,edit,write,grep,find,ls');
  assert.match(fake.calls[4].args.at(-1), /Reviewer feedback/i);
  provider.close();
});

test('finishing the final child completes the planned parent checklist', () => {
  const root = tempProject();
  writeWorkflow(root, { autoReview: false });
  const parentPath = writeTicket(root, 'parent-objective', { state: 'planned' });
  writeTicket(root, 'first-child', { state: 'done', parentId: 'parent-objective' });
  const finalChild = writeTicket(root, 'final-child', { parentId: 'parent-objective' });
  const fake = fakeSpawn();
  const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn });
  provider.dispatch(finalChild);
  closeCall(fake.calls[0]);
  const parent = provider.resolveTicket(parentPath);
  assert.equal(parent.state, 'done');
  assert.equal(parent.acceptanceCriteria.every((item) => item.completed), true);
  provider.close();
});

test('duplicate IDs and missing blockers are surfaced and never eligible', () => {
  const root = tempProject();
  writeWorkflow(root);
  writeTicket(root, 'duplicate');
  writeTicket(root, 'DUPLICATE');
  writeTicket(root, 'missing-ref', { blockedBy: ['does-not-exist'] });
  const provider = new PiMarkdownProvider({ roots: [root] });
  const tickets = provider.listTickets();
  assert.equal(tickets.filter((ticket) => ticket.id.toLowerCase() === 'duplicate').every((ticket) => ticket.duplicateId && ticket.status === 'needs_attention'), true);
  assert.match(tickets.find((ticket) => ticket.id === 'missing-ref').issue, /Missing blocker/i);
  assert.equal(provider.eligible(root), undefined);
  provider.close();
});

test('project roots are canonicalized and malformed state is never overwritten', () => {
  const target = tempProject();
  writeWorkflow(target);
  const aliasParent = tempProject();
  const alias = path.join(aliasParent, 'project-link');
  fs.symlinkSync(target, alias);
  const provider = new PiMarkdownProvider({ roots: [alias] });
  assert.deepEqual(provider.roots, [target]);
  assert.equal(provider.createTicket({ cwd: alias, title: 'Via alias' }).cwd, target);
  provider.close();

  const corrupt = tempProject();
  fs.mkdirSync(path.join(corrupt, '.orchestration'));
  const statePath = path.join(corrupt, '.orchestration', 'state.json');
  fs.writeFileSync(statePath, '{not valid json', 'utf8');
  assert.throws(() => new PiMarkdownProvider({ roots: [corrupt] }), /state is malformed/i);
  assert.equal(fs.readFileSync(statePath, 'utf8'), '{not valid json');
});

test('symlinked orchestration, tickets, sessions, workspaces, and runs files are rejected', () => {
  const external = tempProject();

  const stateRoot = tempProject();
  fs.symlinkSync(external, path.join(stateRoot, '.orchestration'));
  assert.throws(() => new PiMarkdownProvider({ roots: [stateRoot] }), /symlink/i);

  const ticketRoot = tempProject();
  const ticketProvider = new PiMarkdownProvider({ roots: [ticketRoot] });
  fs.symlinkSync(external, path.join(ticketRoot, '.tickets'));
  assert.throws(() => ticketProvider.snapshot(), /symlink/i);
  ticketProvider.close();

  const sessionRoot = tempProject();
  writeWorkflow(sessionRoot);
  const sessionTicket = writeTicket(sessionRoot, 'session-link');
  const sessionProvider = new PiMarkdownProvider({ roots: [sessionRoot], spawn: fakeSpawn().spawn });
  fs.mkdirSync(path.join(sessionRoot, '.orchestration'), { recursive: true });
  fs.symlinkSync(external, path.join(sessionRoot, '.orchestration', 'sessions'));
  assert.throws(() => sessionProvider.dispatch(sessionTicket), /symlink/i);
  sessionProvider.close();

  const workspaceRoot = tempProject();
  writeWorkflow(workspaceRoot, { workspaceMode: 'worktree' });
  const workspaceTicket = writeTicket(workspaceRoot, 'workspace-link');
  const workspaceProvider = new PiMarkdownProvider({ roots: [workspaceRoot], spawn: fakeSpawn().spawn, execFile: () => '' });
  fs.mkdirSync(path.join(workspaceRoot, '.orchestration'), { recursive: true });
  fs.symlinkSync(external, path.join(workspaceRoot, '.orchestration', 'workspaces'));
  assert.throws(() => workspaceProvider.dispatch(workspaceTicket), /symlink/i);
  workspaceProvider.close();

  const runsRoot = tempProject();
  const runsProvider = new PiMarkdownProvider({ roots: [runsRoot] });
  fs.symlinkSync(path.join(external, 'events.jsonl'), path.join(runsRoot, '.orchestration', 'runs.jsonl'));
  assert.throws(() => appendRun(runsRoot, { event: 'nope' }), /symlink/i);
  runsProvider.close();
});
