const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PiMarkdownProvider } = require('./provider.cjs');
const { cleanupWorktree } = require('./integration.cjs');
const { loadState, saveState } = require('./state.cjs');

function git(cwd, args, options = {}) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', ...options }).trim(); }
function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-cleanup-')));
  git(root, ['init', '-q', '-b', 'main']); git(root, ['config', 'user.name', 'Cleanup Test']); git(root, ['config', 'user.email', 'cleanup@example.invalid']);
  fs.mkdirSync(path.join(root, '.tickets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'WORKFLOW.md'), '---\nworkspaceMode: worktree\nautoReview: true\n---\ncleanup test\n');
  fs.writeFileSync(path.join(root, '.tickets', 'ticket.md'), '---\nid: cleanup-ticket\nstate: done\n---\n# Cleanup\n\n## Acceptance criteria\n\n- [x] complete\n');
  fs.writeFileSync(path.join(root, 'root.txt'), 'root bytes\n');
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'base']);
  return root;
}
function setup({ cleanup = 'needs_attention', ignored = false } = {}) {
  const root = repo(); const ticketPath = path.join(root, '.tickets', 'ticket.md');
  if (ignored) { fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n'); git(root, ['add', '.gitignore']); git(root, ['commit', '-qm', 'ignore']); }
  const hash = require('node:crypto').createHash('sha256').update(path.resolve(ticketPath)).digest('hex').slice(0, 10);
  const workspace = path.join(root, '.orchestration', 'workspaces', `cleanup-ticket-${hash}`);
  const branch = `constellation/cleanup-ticket-${hash}`;
  fs.mkdirSync(path.dirname(workspace), { recursive: true }); git(root, ['worktree', 'add', '-q', '-b', branch, workspace]);
  fs.writeFileSync(path.join(workspace, 'feature.txt'), 'reviewed\n');
  fs.writeFileSync(path.join(workspace, '.tickets', 'ticket.md'), fs.readFileSync(ticketPath));
  git(workspace, ['add', '-A']); git(workspace, ['commit', '-qm', 'reviewed source']);
  const sourceHead = git(workspace, ['rev-parse', 'HEAD']); const baseHead = git(root, ['rev-parse', 'HEAD']);
  git(root, ['merge', '--no-ff', '--no-edit', sourceHead]); const mergeCommit = git(root, ['rev-parse', 'HEAD']);
  const claimKey = path.join(root, '.tickets', 'ticket.md');
  const runId = `cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const metadata = { mode: 'worktree', destinationRoot: root, topLevel: root, destinationBranch: 'main', baseHead, destinationHeadBeforeMerge: baseHead, ownedWorkspace: workspace, sourceBranch: branch, sourceHead, sourceTicketPath: path.join(workspace, '.tickets', 'ticket.md'), sourceTicketHash: require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(workspace, '.tickets', 'ticket.md'))).digest('hex'), phase: 'integrated', mergeCommit };
  const state = loadState(root); state.claims[claimKey] = { runId, ticketId: 'cleanup-ticket', ticketPath: ticketPath, phase: 'integrated', status: 'completed', integration: { ...metadata, cleanup: { phase: cleanup } } }; state.runs[runId] = { ...state.claims[claimKey] }; saveState(root, state);
  return { root, workspace, ticketPath, claimKey, runId, metadata, baseHead, mergeCommit };
}
function providerFor(root, execFile) { return new PiMarkdownProvider({ roots: [root], execFile, isProcessAlive: () => false }); }

test('auto cleanup removes exactly the owned workspace, keeps lock through remove, and never changes root', () => {
  const x = setup({ cleanup: 'pending' }); const rootBefore = fs.readFileSync(path.join(x.root, 'root.txt')); const headBefore = git(x.root, ['rev-parse', 'HEAD']); let sawLock = false;
  const realExec = execFileSync; const spy = (command, args, options) => { if (args.includes('worktree') && args.includes('remove')) sawLock = fs.existsSync(path.join(x.root, '.orchestration', 'integration.lock')); return realExec(command, args, options); };
  const p = providerFor(x.root, spy); try { assert.equal(fs.existsSync(x.workspace), false); assert.equal(git(x.root, ['rev-parse', 'HEAD']), headBefore); assert.deepEqual(fs.readFileSync(path.join(x.root, 'root.txt')), rootBefore); assert.equal(sawLock, true); assert.equal(fs.existsSync(path.join(x.root, '.orchestration', 'integration.lock')), false); assert.equal(loadState(x.root).claims[x.claimKey].integration.cleanup.phase, 'cleaned'); } finally { p.close(); }
});

test('cleanup refuses every dirty class without altering bytes, including ignored and orchestration files', () => {
  for (const kind of ['tracked', 'staged', 'untracked', 'ignored', 'orchestration']) {
    const x = setup({ cleanup: 'pending', ignored: kind === 'ignored' }); const file = kind === 'orchestration' ? path.join(x.workspace, '.orchestration', 'runtime') : path.join(x.workspace, `${kind}.txt`); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(`${kind}-bytes`)); if (kind === 'staged') git(x.workspace, ['add', file]);
    const before = fs.readFileSync(file); assert.throws(() => cleanupWorktree({ metadata: x.metadata, expectedWorkspace: x.workspace, expectedBranch: x.metadata.sourceBranch }), kind === 'ignored' ? /fully clean|dirty|clean/i : /clean|dirty|HEAD/i); assert.deepEqual(fs.readFileSync(file), before); assert.ok(fs.existsSync(x.workspace));
  }
});

test('every in-progress Git operation refuses even with a clean index', () => {
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    const x = setup({ cleanup: 'pending' }); const markerPath = git(x.workspace, ['rev-parse', '--git-path', marker]); const absolute = path.isAbsolute(markerPath) ? markerPath : path.resolve(x.workspace, markerPath); fs.mkdirSync(path.dirname(absolute), { recursive: true }); if (marker.endsWith('merge') || marker === 'rebase-apply' || marker === 'sequencer') fs.mkdirSync(absolute); else fs.writeFileSync(absolute, 'marker\n');
    assert.throws(() => cleanupWorktree({ metadata: x.metadata, expectedWorkspace: x.workspace, expectedBranch: x.metadata.sourceBranch }), /in-progress Git operation/i); assert.ok(fs.existsSync(x.workspace));
  }
});

test('unresolved merge and unmerged index entries refuse before removal', () => {
  const x = setup({ cleanup: 'pending' });
  // Install real stage-1/2/3 index entries without moving HEAD.
  const blob = git(x.workspace, ['hash-object', '-w', '--stdin'], { input: 'conflict\n' });
  git(x.workspace, ['update-index', '--index-info'], { input: `100644 ${blob} 1\tfeature.txt\n100644 ${blob} 2\tfeature.txt\n` });
  assert.throws(() => cleanupWorktree({ metadata: x.metadata, expectedWorkspace: x.workspace, expectedBranch: x.metadata.sourceBranch }), /unresolved|unmerged|clean/i); assert.ok(fs.existsSync(x.workspace));
});

test('deterministic identity, liveness, and non-integrated guards do not remove worktrees', () => {
  for (const mutate of [
    (x) => { x.metadata.ownedWorkspace += '-wrong'; },
    (x) => { x.metadata.sourceBranch = 'foreign'; },
    (x) => { x.metadata.sourceHead = '0'.repeat(40); },
    (x) => { x.metadata.phase = 'pending_review'; },
  ]) { const x = setup({ cleanup: 'pending' }); mutate(x); assert.throws(() => cleanupWorktree({ metadata: x.metadata, expectedWorkspace: x.workspace, expectedBranch: x.metadata.sourceBranch })); assert.ok(fs.existsSync(x.workspace)); }
  const x = setup({ cleanup: 'pending' }); assert.throws(() => cleanupWorktree({ metadata: x.metadata, expectedWorkspace: x.workspace, expectedBranch: x.metadata.sourceBranch, ownedPids: [123], liveProcessCheck: () => true }), /running/i); assert.ok(fs.existsSync(x.workspace));
});

test('constructor reconciles pending and cleaning workspaces exactly once, while attention waits for explicit cleanup', () => {
  for (const phase of ['pending', 'cleaning']) {
    const x = setup({ cleanup: phase }); const p = providerFor(x.root); try { assert.equal(fs.existsSync(x.workspace), false); assert.equal(loadState(x.root).claims[x.claimKey].integration.cleanup.phase, 'cleaned'); assert.equal(p.cleanupRun(x.runId).action, 'already-cleaned'); } finally { p.close(); }
  }
  const y = setup({ cleanup: 'needs_attention' }); const before = loadState(y.root); const q = providerFor(y.root); try { assert.equal(loadState(y.root).claims[y.claimKey].integration.cleanup.phase, 'needs_attention'); assert.equal(fs.existsSync(y.workspace), true); } finally { q.close(); } assert.equal(loadState(y.root).claims[y.claimKey].integration.cleanup.phase, 'needs_attention'); const r = providerFor(y.root); try { assert.equal(r.cleanupRun(y.runId).action, 'removed'); } finally { r.close(); } assert.equal(fs.existsSync(y.workspace), false); assert.equal(loadState(y.root).claims[y.claimKey].integration.cleanup.phase, 'cleaned'); assert.equal(before.claims[y.claimKey].integration.cleanup.phase, 'needs_attention');
});

test('malformed and unknown recovery IDs fail before Git access; root-mode cleanup is non-mutating', () => {
  const x = setup(); const p = providerFor(x.root); try { for (const value of [undefined, null, 7, '', 'bad id']) { assert.throws(() => p.cleanupRun(value), /Malformed/); assert.throws(() => p.retryReview(value), /Malformed/); assert.throws(() => p.retryIntegration(value), /Malformed/); } assert.throws(() => p.cleanupRun('unknown-run'), /not found/i); } finally { p.close(); }
  const root = repo(); const ticket = path.join(root, '.tickets', 'ticket.md'); const state = loadState(root); const claim = { runId: 'root-run', ticketPath: ticket, phase: 'integrated', status: 'completed', integration: { mode: 'root', phase: 'integrated' } }; state.claims[ticket] = claim; state.runs[claim.runId] = claim; saveState(root, state); const q = new PiMarkdownProvider({ roots: [] }); q.roots = [root]; try { assert.throws(() => q.cleanupRun('root-run'), /worktree/i); } finally { q.close(); } assert.deepEqual(loadState(root).claims[ticket], claim);
});

function fakePiSpawn(calls) { return (command, args, options) => { calls.push({ command, args, options }); const child = new EventEmitter(); child.pid = 41000 + calls.length; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); return child; }; }
function overwriteClaim(root, key, runId, integration, fields = {}) { const state = loadState(root); const claim = { ...(state.claims[key] || {}), runId, phase: fields.phase || integration.phase, status: fields.status || 'needs_attention', integration, ...fields }; state.claims[key] = claim; state.runs[runId] = { ...claim }; saveState(root, state); return claim; }

test('retryReview succeeds only at unchanged captured source', () => {
  const x = setup({ cleanup: 'needs_attention' }); git(x.root, ['reset', '-q', '--hard', x.baseHead]); const integration = { ...x.metadata, phase: 'pending_review' }; overwriteClaim(x.root, x.claimKey, x.runId, integration, { phase: 'needs_attention' }); const calls = []; const p = new PiMarkdownProvider({ roots: [x.root], spawn: fakePiSpawn(calls), isProcessAlive: () => false });
  try { const result = p.retryReview(x.runId); assert.equal(calls.length, 1); assert.equal(calls[0].options.cwd, x.workspace); const prompt = calls[0].args[calls[0].args.indexOf('-p') + 1]; assert.match(prompt, new RegExp(x.metadata.sourceHead)); const claim = loadState(x.root).claims[x.claimKey]; assert.equal(claim.phase, 'reviewer'); assert.equal(claim.status, 'running'); assert.equal(result.dispatched, true); } finally { p.close(); }
  const y = setup({ cleanup: 'needs_attention' }); const original = { ...y.metadata, phase: 'pending_review' }; overwriteClaim(y.root, y.claimKey, y.runId, original, { phase: 'needs_attention' }); const secondCalls = []; const q = new PiMarkdownProvider({ roots: [y.root], spawn: fakePiSpawn(secondCalls), isProcessAlive: () => false }); try { fs.writeFileSync(path.join(y.workspace, 'later.txt'), 'later\n'); git(y.workspace, ['add', 'later.txt']); git(y.workspace, ['commit', '-qm', 'moved']); assert.throws(() => q.retryReview(y.runId), /moved|identity|HEAD/i); assert.equal(secondCalls.length, 0); assert.equal(loadState(y.root).claims[y.claimKey].integration.sourceHead, original.sourceHead); } finally { q.close(); }
});

test('retryReview refuses persisted live or unknown worker liveness before spawn', () => {
  for (const liveness of [() => true, () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); }]) {
    const x = setup({ cleanup: 'needs_attention' }); git(x.root, ['reset', '-q', '--hard', x.baseHead]);
    const integration = { ...x.metadata, phase: 'pending_review' }; overwriteClaim(x.root, x.claimKey, x.runId, integration, { phase: 'needs_attention' });
    const state = loadState(x.root); state.runs['other-worker'] = { runId: 'other-worker', ticketPath: x.ticketPath, phase: 'worker', status: 'running', pid: 777 }; saveState(x.root, state);
    const calls = []; const p = new PiMarkdownProvider({ roots: [x.root], spawn: fakePiSpawn(calls), isProcessAlive: liveness });
    try { assert.throws(() => p.retryReview(x.runId), /already running|liveness is unknown/i); assert.equal(calls.length, 0); } finally { p.close(); }
  }
});

test('retryIntegration persists actionable attention without metadata drift across reload', () => {
  const x = setup({ cleanup: 'needs_attention' }); git(x.root, ['reset', '-q', '--hard', x.baseHead]);
  const integration = { ...x.metadata, phase: 'integration_pending', cleanup: { phase: 'needs_attention' } }; overwriteClaim(x.root, x.claimKey, x.runId, integration, { phase: 'needs_attention' });
  fs.writeFileSync(path.join(x.workspace, 'dirty.txt'), 'do not integrate\n');
  const p = new PiMarkdownProvider({ roots: [x.root], isProcessAlive: () => false });
  try { assert.throws(() => p.retryIntegration(x.runId), /clean|dirty/i); } finally { p.close(); }
  const failed = loadState(x.root).claims[x.claimKey]; assert.equal(failed.status, 'needs_attention'); assert.equal(failed.phase, 'needs_attention'); assert.equal(failed.integration.phase, 'integration_pending'); assert.match(failed.integration.error, /Retry integration/i); assert.equal(failed.integration.sourceHead, integration.sourceHead); assert.equal(failed.integration.ownedWorkspace, integration.ownedWorkspace);
  const reloaded = new PiMarkdownProvider({ roots: [x.root], isProcessAlive: () => false }); try { const after = loadState(x.root).claims[x.claimKey]; assert.equal(after.integration.error, failed.integration.error); assert.equal(after.integration.phase, 'integration_pending'); } finally { reloaded.close(); }
});

test('retryIntegration integrates once then cleans', () => {
  const x = setup({ cleanup: 'needs_attention' }); git(x.root, ['reset', '-q', '--hard', x.baseHead]); const integration = { ...x.metadata, phase: 'integration_pending', cleanup: { phase: 'needs_attention' } }; const p = new PiMarkdownProvider({ roots: [x.root], isProcessAlive: () => false });
  try { overwriteClaim(x.root, x.claimKey, x.runId, integration, { phase: 'needs_attention' }); const result = p.retryIntegration(x.runId); assert.equal(result.phase, 'integrated'); assert.equal(result.cleanup.phase, 'cleaned'); assert.deepEqual(require('./integration.cjs').exactParents(x.root, result.mergeCommit), [x.baseHead, x.metadata.sourceHead]); assert.equal(fs.existsSync(x.workspace), false); assert.ok(git(x.root, ['show-ref', '--verify', `refs/heads/${x.metadata.sourceBranch}`])); const head = git(x.root, ['rev-parse', 'HEAD']); assert.throws(() => p.retryIntegration(x.runId), /not allowed|retry/i); assert.equal(git(x.root, ['rev-parse', 'HEAD']), head); } finally { p.close(); }
  const y = setup({ cleanup: 'needs_attention' }); const q = new PiMarkdownProvider({ roots: [y.root], isProcessAlive: () => false }); try { const pending = { ...y.metadata, phase: 'pending_review' }; overwriteClaim(y.root, y.claimKey, y.runId, pending, { phase: 'needs_attention' }); const before = loadState(y.root).claims[y.claimKey].integration; assert.throws(() => q.retryIntegration(y.runId), /pending_review|not allowed/i); assert.deepEqual(loadState(y.root).claims[y.claimKey].integration, before); } finally { q.close(); }
});

test('retryIntegration rejects a same-repository foreign worktree before touching Git', () => {
  const x = setup({ cleanup: 'needs_attention' });
  git(x.root, ['reset', '-q', '--hard', x.baseHead]);
  const foreignWorkspace = path.join(x.root, '.orchestration', 'workspaces', 'foreign-worktree');
  const foreignBranch = 'constellation/foreign-worktree';
  git(x.root, ['worktree', 'add', '-q', '-b', foreignBranch, foreignWorkspace, x.baseHead]);
  const foreignHead = git(foreignWorkspace, ['rev-parse', 'HEAD']);
  const integration = { ...x.metadata, phase: 'integration_pending', cleanup: { phase: 'needs_attention' }, ownedWorkspace: foreignWorkspace, sourceBranch: foreignBranch, sourceHead: foreignHead, sourceTicketPath: path.join(foreignWorkspace, '.tickets', 'ticket.md') };
  overwriteClaim(x.root, x.claimKey, x.runId, integration, { phase: 'needs_attention' });
  const beforeState = loadState(x.root);
  const beforeHead = git(x.root, ['rev-parse', 'HEAD']);
  const beforeTree = git(x.root, ['rev-parse', 'HEAD^{tree}']);
  const calls = [];
  const realExec = execFileSync;
  const spy = (command, args, options) => { calls.push(args); return realExec(command, args, options); };
  const p = new PiMarkdownProvider({ roots: [], execFile: spy, isProcessAlive: () => false }); p.roots = [x.root];
  try {
    assert.throws(() => p.retryIntegration(x.runId), /deterministic|workspace|source ticket|branch/i);
    assert.equal(git(x.root, ['rev-parse', 'HEAD']), beforeHead);
    assert.equal(git(x.root, ['rev-parse', 'HEAD^{tree}']), beforeTree);
    assert.equal(calls.some((args) => args.includes('merge') || args.includes('commit') || (args.includes('worktree') && args.includes('remove'))), false);
    assert.equal(fs.existsSync(x.workspace), true);
    assert.equal(fs.existsSync(foreignWorkspace), true);
    assert.deepEqual(loadState(x.root), beforeState);
  } finally { p.close(); }
});

test('cleanup recovery after remove and needs-attention manual', () => {
  const x = setup({ cleanup: 'cleaning' }); fs.rmSync(x.workspace, { recursive: true, force: true }); git(x.root, ['worktree', 'prune']); const p = providerFor(x.root); try { assert.equal(loadState(x.root).claims[x.claimKey].integration.cleanup.phase, 'cleaned'); } finally { p.close(); }
  const y = setup({ cleanup: 'needs_attention' }); let removes = 0; const real = execFileSync; const spy = (command, args, options) => { if (args.includes('worktree') && args.includes('remove')) removes++; return real(command, args, options); }; const q = providerFor(y.root, spy); try { assert.equal(removes, 0); q.cleanupRun(y.runId); assert.equal(removes, 1); } finally { q.close(); }
});

test('cleanup identity and liveness refusal matrix', () => {
  const cases = [['sourceTicket path tamper', x => { x.metadata.sourceTicketPath = path.join(x.workspace, 'foreign.md'); }], ['actual branch rename', x => git(x.root, ['branch', '-m', x.metadata.sourceBranch, `${x.metadata.sourceBranch}-renamed`])], ['workspace HEAD new commit', x => { fs.writeFileSync(path.join(x.workspace, 'new.txt'), 'new\n'); git(x.workspace, ['add', 'new.txt']); git(x.workspace, ['commit', '-qm', 'new']); }], ['same-repo foreign deterministic metadata', x => { x.metadata.ownedWorkspace = path.join(x.root, '.orchestration', 'workspaces', 'foreign-0000000000'); }], ['symlinked workspace', x => { fs.rmSync(x.workspace, { recursive: true }); fs.symlinkSync(x.root, x.workspace); }], ['symlinked workspace parent', x => { const parent = path.dirname(x.workspace); const moved = `${parent}-real`; fs.renameSync(parent, moved); fs.symlinkSync(moved, parent, 'dir'); }]];
  for (const [name, mutate] of cases) { const x = setup({ cleanup: 'needs_attention' }); mutate(x); const state = loadState(x.root); state.claims[x.claimKey].integration = x.metadata; state.runs[x.runId].integration = x.metadata; saveState(x.root, state); const p = providerFor(x.root); try { assert.throws(() => p.cleanupRun(x.runId), /identity|path|branch|HEAD|symlink|workspace|ticket/i, name); } finally { p.close(); } }
  for (const [label, check] of [['live PID', () => true], ['liveness EPERM', () => { throw Object.assign(new Error('permission'), { code: 'EPERM' }); }], ['liveness EIO', () => { throw Object.assign(new Error('io'), { code: 'EIO' }); }]]) { const x = setup({ cleanup: 'needs_attention' }); const before = fs.readFileSync(path.join(x.workspace, '.tickets', 'ticket.md')); try { assert.throws(() => cleanupWorktree({ metadata: x.metadata, expectedWorkspace: x.workspace, expectedBranch: x.metadata.sourceBranch, ownedPids: [49123], liveProcessCheck: check }), /running|permission|io|still/i, label); assert.ok(fs.existsSync(x.workspace)); assert.deepEqual(fs.readFileSync(path.join(x.workspace, '.tickets', 'ticket.md')), before); } finally {} }
});

test('historical destination movement and command audit', () => {
  const x = setup({ cleanup: 'needs_attention' }); fs.writeFileSync(path.join(x.root, 'later.txt'), 'later\n'); git(x.root, ['add', 'later.txt']); git(x.root, ['commit', '-qm', 'later']); const commands = []; const real = execFileSync; const spy = (command, args, options) => { commands.push(args); return real(command, args, options); }; const p = providerFor(x.root, spy); try { assert.equal(p.cleanupRun(x.runId).action, 'removed'); } finally { p.close(); } const remove = commands.filter(args => args.includes('worktree') && args.includes('remove')); assert.equal(remove.length, 1); assert.deepEqual(remove[0].slice(-2), ['--', x.workspace]); assert.equal(remove[0].includes('--force'), false); assert.ok(git(x.root, ['show-ref', '--verify', `refs/heads/${x.metadata.sourceBranch}`]));
});
