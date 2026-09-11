const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { PiMarkdownProvider } = require('./provider.cjs');
const { loadState, saveState } = require('./state.cjs');
const { preflight, captureReviewed, integrateReviewed, reconcileIntegration, acquireIntegrationLock, assertClean } = require('./integration.cjs');

function git(root, args, options = {}) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', ...options }).trim(); }
function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-pi-integration-')));
  git(root, ['init', '-q', '-b', 'main']); git(root, ['config', 'user.email', 'test@example.invalid']); git(root, ['config', 'user.name', 'Constellation Test']);
  fs.mkdirSync(path.join(root, '.tickets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'WORKFLOW.md'), '---\nautoReview: true\nworkspaceMode: worktree\nretryMax: 3\n---\nTest workflow.\n');
  return root;
}
function writeTicket(root, id, extra = '') {
  const file = path.join(root, '.tickets', `${id}.md`);
  const state = extra.includes('state: planned') ? 'planned' : 'todo';
  fs.writeFileSync(file, `---\nid: ${id}\nstate: ${state}\n${extra.replace('state: planned\\n', '')}---\n# ${id}\n\nDo ${id}.\n\n## Acceptance criteria\n\n- [ ] Complete ${id}\n`); return file;
}
function commit(root, message) { git(root, ['add', '-A']); git(root, ['commit', '-qm', message]); return git(root, ['rev-parse', 'HEAD']); }
function init(root, files = {}) { for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(root, name), value); return commit(root, 'base'); }
function fakePi() {
  const calls = []; let pid = 30000;
  const spawn = (command, args, options) => { const child = new EventEmitter(); child.pid = pid++; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true; calls.push({ command, args, options, child }); return child; };
  return { calls, spawn };
}
function finish(call, text = '', code = 0) { if (text) call.child.stdout.emit('data', `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(text) }] } })}\n`); call.child.emit('close', code, null); }
function value(call, flag) { const i = call.args.indexOf(flag); return i < 0 ? undefined : call.args[i + 1]; }
function workspace(call) { return call.options.cwd; }
function sourceCommit(call, file, contents, ticketPath) { fs.writeFileSync(path.join(workspace(call), file), contents); fs.writeFileSync(path.join(workspace(call), '.tickets', path.basename(ticketPath)), fs.readFileSync(ticketPath, 'utf8').replace('state: todo', 'state: done').replace('- [ ]', '- [x]')); return commit(workspace(call), `work on ${path.basename(ticketPath)}`); }
function forbiddenGitSpy(root) {
  const calls = [];
  const execFile = (command, args, options) => { calls.push([command, ...args]); return execFileSync(command, args, options); };
  return { calls, execFile };
}

// End-to-end worker/reviewer children are intentionally fake, but every repository and Git operation is real.
test('worker commit -> exact reviewer -> integration preserves root bytes and HEAD until reviewer PASS', () => {
  const root = makeRepo(); const ticket = writeTicket(root, 'exact-review'); init(root, { 'root.txt': 'root bytes\n' }); const beforeBytes = fs.readFileSync(path.join(root, 'root.txt')); const beforeTicketBytes = fs.readFileSync(ticket); const before = git(root, ['rev-parse', 'HEAD']);
  const fake = fakePi(); const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn });
  try {
    provider.dispatch(ticket); const source = sourceCommit(fake.calls[0], 'worker.txt', 'worker\n', ticket); finish(fake.calls[0]);
    let state = loadState(root); assert.equal(state.claims[ticket].integration.phase, 'pending_review'); assert.equal(provider.eligible(root), undefined);
    assert.deepEqual(fs.readFileSync(path.join(root, 'root.txt')), beforeBytes); assert.deepEqual(fs.readFileSync(ticket), beforeTicketBytes); assert.equal(git(root, ['rev-parse', 'HEAD']), before); assert.match(value(fake.calls[1], '-p'), /exact source HEAD/);
    finish(fake.calls[1], 'REVIEW: PASS'); state = loadState(root); assert.equal(state.claims[ticket].integration.phase, 'integrated'); assert.equal(git(root, ['rev-parse', 'HEAD~1']), before); assert.deepEqual(git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/).slice(1), [before, source]);
  } finally { provider.close(); }
});

test('tracked and untracked dirty roots refuse before creating a child and preserve bytes', () => {
  for (const kind of ['tracked', 'untracked']) { const root = makeRepo(); const ticket = writeTicket(root, `dirty-${kind}`); init(root, { 'root.txt': 'original\n' }); const before = fs.readFileSync(path.join(root, 'root.txt')); const beforeHead = git(root, ['rev-parse', 'HEAD']); if (kind === 'tracked') fs.writeFileSync(path.join(root, 'root.txt'), 'tampered\n'); else fs.writeFileSync(path.join(root, 'new-untracked'), 'new\n'); const fake = fakePi(); const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn }); try { assert.throws(() => provider.dispatch(ticket), /not clean/i); assert.equal(fake.calls.length, 0); assert.deepEqual(fs.readFileSync(path.join(root, 'root.txt')), kind === 'tracked' ? Buffer.from('tampered\n') : before); assert.equal(git(root, ['rev-parse', 'HEAD']), beforeHead); } finally { provider.close(); } }
});

test('moved branch and unrelated HEAD are refused without claiming a child', () => {
  const root = makeRepo(); const ticket = writeTicket(root, 'moved'); init(root, { 'root.txt': 'base\n' }); const fake = fakePi(); const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn }); try { const run = provider.dispatch(ticket); const source = sourceCommit(fake.calls[0], 'change', 'one\n', ticket); finish(fake.calls[0]); git(workspace(fake.calls[0]), ['branch', '-m', 'renamed-source']); git(root, ['commit', '--allow-empty', '-qm', 'unrelated']); finish(fake.calls[1], 'REVIEW: PASS'); const state = loadState(root); assert.equal(state.claims[ticket].phase, 'needs_attention'); assert.equal(git(workspace(fake.calls[0]), ['rev-parse', 'HEAD']), source); assert.equal(run.id, 'moved'); } finally { provider.close(); } }
);

test('two same-base tickets integrate in deterministic serialized order when non-conflicting', () => {
  const root = makeRepo(); const a = writeTicket(root, 'order-a'); const b = writeTicket(root, 'order-b'); const base = init(root, { 'root.txt': 'base\n' }); const fake = fakePi(); const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn }); try { provider.dispatch(a); provider.dispatch(b); const sa = sourceCommit(fake.calls[0], 'a.txt', 'a\n', a); const sb = sourceCommit(fake.calls[1], 'b.txt', 'b\n', b); finish(fake.calls[0]); finish(fake.calls[1]); finish(fake.calls[2], 'REVIEW: PASS'); finish(fake.calls[3], 'REVIEW: PASS'); const parents = git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/).slice(1); assert.equal(parents[0] !== base, true); assert.deepEqual(git(root, ['show', '-s', '--format=%P', parents[0]]).split(/\s+/), [base, sa]); assert.equal(git(root, ['merge-base', '--is-ancestor', sb, 'HEAD']), ''); assert.equal(loadState(root).claims[a].integration.phase, 'integrated'); assert.equal(loadState(root).claims[b].integration.phase, 'integrated'); } finally { provider.close(); } }
);

test('conflict from first recorded integration vs second source preserves MERGE_HEAD, conflict files, and worktrees without abort/reset', () => {
  const root = makeRepo(); const a = writeTicket(root, 'conflict-a'); const b = writeTicket(root, 'conflict-b'); init(root, { 'same.txt': 'base\n' }); const fake = fakePi(); const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn }); try { provider.dispatch(a); provider.dispatch(b); sourceCommit(fake.calls[0], 'same.txt', 'A\n', a); sourceCommit(fake.calls[1], 'same.txt', 'B\n', b); finish(fake.calls[0]); finish(fake.calls[1]); finish(fake.calls[2], 'REVIEW: PASS'); finish(fake.calls[3], 'REVIEW: PASS'); assert.ok(fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'))); assert.match(fs.readFileSync(path.join(root, 'same.txt'), 'utf8'), /<<<<<<|====|>>>>>>/); assert.ok(fs.existsSync(workspace(fake.calls[0]))); assert.ok(fs.existsSync(workspace(fake.calls[1]))); const state = loadState(root); assert.equal(state.claims[b].phase, 'needs_attention'); } finally { provider.close(); } }
);

test('restart pending review becomes durable attention without relaunching or integrating', () => {
  const root = makeRepo(); const ticket = writeTicket(root, 'review-restart'); const base = init(root, { base: 'x\n' }); const fake = fakePi(); const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn });
  try { provider.dispatch(ticket); const metadata = loadState(root).claims[ticket].integration; const ws = metadata.ownedWorkspace; fs.writeFileSync(path.join(ws, 'change'), 'y\n'); const source = commit(ws, 'source'); const state = loadState(root); const claim = state.claims[ticket]; claim.runId = 'review-restart-run'; claim.phase = 'pending_review'; claim.status = 'completed'; claim.integration = { ...metadata, sourceHead: source, sourceTicketPath: path.join(ws, '.tickets', 'review-restart.md'), phase: 'pending_review' }; state.claims[ticket] = claim; state.runs[claim.runId] = claim; saveState(root, state); provider.close();
    const restarted = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn }); try { const after = loadState(root); assert.equal(after.claims[ticket].status, 'needs_attention'); assert.equal(after.claims[ticket].phase, 'needs_attention'); assert.match(after.claims[ticket].error, /review interrupted.*retry review/i); assert.equal(after.claims[ticket].integration.sourceHead, source); assert.equal(git(root, ['rev-parse', 'HEAD']), base); assert.equal(fake.calls.length, 1); assert.equal(restarted.eligible(root), undefined); } finally { restarted.close(); }
  } finally { if (provider.children.size) provider.close(); }
});

test('restart integration_pending auto-integrates once and integrating exact merge recovers without merging twice', () => {
  const root = makeRepo(); const ticket = writeTicket(root, 'restart'); const base = init(root, { base: 'x\n' });
  const ticketBytes = fs.readFileSync(ticket); const fake = fakePi(); const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn }); provider.dispatch(ticket); const state = loadState(root); const metadata = state.claims[ticket].integration; const ws = metadata.ownedWorkspace; provider.close(); fs.writeFileSync(ticket, ticketBytes); git(root, ['checkout', '--', ticket]);
  fs.writeFileSync(path.join(ws, 'new'), 'y\n'); fs.writeFileSync(path.join(ws, '.tickets', 'restart.md'), fs.readFileSync(ticket, 'utf8').replace('state: todo', 'state: done').replace('- [ ]', '- [x]')); const source = commit(ws, 'source'); const persisted = loadState(root); const claim = persisted.claims[ticket]; claim.phase = 'integration_pending'; claim.status = 'completed'; claim.integration = { ...metadata, sourceHead: source, sourceTicketPath: path.join(ws, '.tickets', 'restart.md'), phase: 'integration_pending' }; persisted.runs['restart-run'] = { ...claim, runId: 'restart-run' }; claim.runId = 'restart-run'; saveState(root, persisted);
  const first = new PiMarkdownProvider({ roots: [root] }); first.close(); const integrated = loadState(root).claims[ticket].integration; assert.equal(integrated.phase, 'integrated'); const firstHead = git(root, ['rev-parse', 'HEAD']); assert.equal(git(root, ['rev-list', '--all', '--count']), '3');
  const second = makeRepo(); const secondTicket = writeTicket(second, 'crash'); const secondBase = init(second, { base: 'x\n' }); const secondWs = path.join(second, '.orchestration', 'workspaces', 'crash-placeholder'); fs.mkdirSync(path.dirname(secondWs), { recursive: true }); git(second, ['worktree', 'add', '-q', '-b', 'constellation/crash', secondWs]); fs.writeFileSync(path.join(secondWs, 'new'), 'y\n'); const secondSource = commit(secondWs, 'source'); git(second, ['merge', '--no-ff', '--no-edit', secondSource]); const recovering = { mode: 'worktree', destinationRoot: second, topLevel: second, destinationBranch: 'main', baseHead: secondBase, destinationHeadBeforeMerge: secondBase, ownedWorkspace: secondWs, sourceBranch: 'constellation/crash', sourceHead: secondSource, sourceTicketPath: path.join(secondWs, '.tickets', 'crash.md'), phase: 'integrating' }; const result = reconcileIntegration({ metadata: recovering }); assert.equal(result.phase, 'completing'); assert.equal(result.mergeCommit, git(second, ['rev-parse', 'HEAD'])); assert.deepEqual(reconcileIntegration({ metadata: { ...recovering, phase: 'integrated', finalDestinationHead: firstHead } }).phase, 'integrated'); assert.equal(git(root, ['rev-parse', 'HEAD']), firstHead);
});

test('correction loop preserves base, workspace, and branch while only latest reviewed HEAD integrates', () => {
  const root = makeRepo(); const ticket = writeTicket(root, 'correction'); const base = init(root, { 'base': 'x\n' }); const fake = fakePi(); const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn }); try { provider.dispatch(ticket); const ws = workspace(fake.calls[0]); const branch = git(ws, ['symbolic-ref', '--short', 'HEAD']); const first = sourceCommit(fake.calls[0], 'first', 'bad\n', ticket); finish(fake.calls[0]); finish(fake.calls[1], 'REVIEW: CHANGES_REQUESTED\nfix'); const correction = sourceCommit(fake.calls[2], 'second', 'good\n', ticket); finish(fake.calls[2]); finish(fake.calls[3], 'REVIEW: PASS'); const state = loadState(root); assert.equal(state.claims[ticket].integration.sourceHead, correction); assert.notEqual(correction, first); assert.equal(state.claims[ticket].integration.baseHead, base); assert.equal(git(ws, ['symbolic-ref', '--short', 'HEAD']), branch); assert.deepEqual(git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/).slice(1), [base, correction]); } finally { provider.close(); } }
);

test('parent remains planned before child integration, then completion commit leaves root clean and records commits', () => {
  const root = makeRepo(); const parent = writeTicket(root, 'parent', 'state: planned\n'); const child = writeTicket(root, 'child', 'parentId: parent\n'); init(root, { 'root': 'clean\n' }); const beforeCommits = git(root, ['rev-list', '--all', '--count']); let lockObserved = false; const execFile = (command, args, options) => { if (command === 'git' && args.includes('commit')) lockObserved = fs.existsSync(path.join(root, '.orchestration', 'integration.lock')); return execFileSync(command, args, options); }; const fake = fakePi(); const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn, execFile }); try { provider.dispatch(child); assert.equal(provider.resolveTicket(parent).state, 'planned'); sourceCommit(fake.calls[0], 'child', 'done\n', child); finish(fake.calls[0]); finish(fake.calls[1], 'REVIEW: PASS'); const state = loadState(root); assert.equal(provider.resolveTicket(parent).state, 'done'); assert.equal(state.claims[child].integration.phase, 'integrated'); assert.ok(state.claims[child].integration.mergeCommit); assert.ok(state.claims[child].integration.completionCommit); assert.equal(git(root, ['show', '--format=', '--name-only', state.claims[child].integration.completionCommit]).trim(), '.tickets/parent.md'); assert.equal(git(root, ['rev-list', '--all', '--count']), String(Number(beforeCommits) + 3)); assert.equal(lockObserved, true); assert.equal(git(root, ['status', '--porcelain', '--untracked-files=all']).split(/\r?\n/).filter((line) => line && !line.includes('.orchestration')).join('\n'), ''); } finally { provider.close(); } }
);

test('integration lock handles live contention, stale recovery, and token-checked release', () => {
  const root = makeRepo(); const release = acquireIntegrationLock(root); try { assert.throws(() => acquireIntegrationLock(root), /live owner/i); const file = path.join(root, '.orchestration', 'integration.lock'); fs.writeFileSync(file, JSON.stringify({ pid: 999999, token: 'stale' })); const recovered = acquireIntegrationLock(root); fs.writeFileSync(file, JSON.stringify({ pid: 999999, token: 'foreign' })); recovered(); assert.ok(fs.existsSync(file)); fs.unlinkSync(file); } finally { release(); } });

test('lock liveness treats EPERM and unknown errors as live and leaves the lock', () => {
  const root = makeRepo(); const file = path.join(root, '.orchestration', 'integration.lock'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ pid: 123, token: 'owner' }));
  for (const code of ['EPERM', 'EIO']) { assert.throws(() => acquireIntegrationLock(root, { isProcessAlive: () => { throw Object.assign(new Error(code), { code }); } }), /live owner/i); assert.ok(fs.existsSync(file)); }
  fs.unlinkSync(file);
});

test('tracked and staged orchestration files remain dirty while untracked runtime files are ignored', () => {
  const root = makeRepo(); init(root, { base: 'x\n' }); const runtime = path.join(root, '.orchestration', 'runtime.log'); fs.mkdirSync(path.dirname(runtime), { recursive: true }); fs.writeFileSync(runtime, 'runtime\n'); assert.doesNotThrow(() => assertClean(root, execFileSync));
  fs.writeFileSync(path.join(root, '.orchestration', 'tracked.txt'), 'one\n'); git(root, ['add', '.orchestration/tracked.txt']); assert.throws(() => assertClean(root, execFileSync), /not clean/i);
});

test('symlinked workspace, foreign worktree, tampered path, and untracked ticket are refused', () => {
  const root = makeRepo(); const ticket = writeTicket(root, 'paths'); init(root); const other = makeRepo(); init(other); const foreign = path.join(other, 'foreign-ws'); git(other, ['worktree', 'add', '-q', '-b', 'foreign', foreign]); assert.throws(() => preflight({ root, workspace: foreign, ticketPath: ticket }), /different Git repository/i); const link = path.join(root, 'link-ws'); fs.symlinkSync(foreign, link); git(root, ['add', 'link-ws']); commit(root, 'record link'); assert.throws(() => preflight({ root, workspace: link, ticketPath: ticket }), /symlink/i); const ticketLink = path.join(root, '.tickets', 'ticket-link.md'); fs.symlinkSync(ticket, ticketLink); assert.throws(() => preflight({ root, workspace: root, ticketPath: ticketLink }), /symlink/i); const untracked = path.join(root, 'untracked.md'); fs.writeFileSync(untracked, fs.readFileSync(ticket)); assert.throws(() => preflight({ root, workspace: root, ticketPath: untracked }), /not tracked|not clean/i); fs.writeFileSync(ticket, 'tampered'); assert.throws(() => preflight({ root, workspace: root, ticketPath: ticket }), /not clean/i); });

test('same-repository foreign persisted worktree is rejected on restart without Git mutation', () => {
  const root = makeRepo(); const ticket = writeTicket(root, 'foreign-restart'); const before = init(root, { base: 'x\n' }); const foreign = path.join(root, 'foreign-worktree'); git(root, ['worktree', 'add', '-q', '-b', 'constellation/foreign', foreign]); fs.writeFileSync(path.join(foreign, 'change'), 'y\n'); const source = commit(foreign, 'source'); const state = loadState(root); const claim = { runId: 'foreign-run', ticketId: 'foreign-restart', ticketPath: ticket, phase: 'integration_pending', status: 'completed', integration: { mode: 'worktree', destinationRoot: root, topLevel: root, destinationBranch: 'main', baseHead: before, ownedWorkspace: foreign, sourceBranch: 'constellation/foreign', sourceHead: source, sourceTicketPath: path.join(foreign, '.tickets', 'foreign-restart.md'), phase: 'integration_pending' } }; state.claims[ticket] = claim; state.runs[claim.runId] = claim; saveState(root, state); const provider = new PiMarkdownProvider({ roots: [root] }); provider.close(); const after = loadState(root); assert.equal(after.claims[ticket].phase, 'needs_attention'); assert.equal(git(root, ['rev-parse', 'HEAD']), before);
});

test('Git invocation spy proves integration never uses reset, clean, checkout, stash, abort, remove, or force commands', () => {
  const root = makeRepo(); const ticket = writeTicket(root, 'spy'); init(root, { 'root': 'x\n' }); const spy = forbiddenGitSpy(root); const fake = fakePi(); const provider = new PiMarkdownProvider({ roots: [root], spawn: fake.spawn, execFile: spy.execFile }); try { provider.dispatch(ticket); sourceCommit(fake.calls[0], 'spy.txt', 'spy\n', ticket); finish(fake.calls[0]); finish(fake.calls[1], 'REVIEW: PASS'); const text = spy.calls.map((x) => x.join(' ')); assert.equal(text.some((x) => /git .*\b(reset|clean|checkout|stash|merge --abort|worktree remove)\b|--force/.test(x)), false, text.join('\n')); } finally { provider.close(); } });
