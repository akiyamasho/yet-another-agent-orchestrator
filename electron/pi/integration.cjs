const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseTicket } = require('./tickets.cjs');

const gitDefault = execFileSync;
function runGit(root, args, execFile = gitDefault) { return String(execFile('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim(); }
function real(p) { return fs.realpathSync(path.resolve(String(p))); }
function gitTop(root, execFile) { return real(runGit(root, ['rev-parse', '--show-toplevel'], execFile)); }
function gitCommon(root, execFile) { const v = runGit(root, ['rev-parse', '--git-common-dir'], execFile); return real(path.isAbsolute(v) ? v : path.join(root, v)); }
function head(root, execFile) { return runGit(root, ['rev-parse', 'HEAD'], execFile); }
function branch(root, execFile) { try { return runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], execFile); } catch { return ''; } }
function status(root, execFile) {
  const output = String(execFile('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const records = output.split('\0'); const dirty = [];
  for (let i = 0; i < records.length; i++) {
    const entry = records[i]; if (!entry) continue;
    const xy = entry.slice(0, 2); const value = entry.slice(3);
    // Only wholly-untracked Constellation runtime files are disposable. A
    // rename/copy (and every other status) is tracked state, even if its path
    // happens to be under .orchestration. The following NUL token is the
    // destination path for porcelain rename/copy records.
    if ((xy === '??') && (value === '.orchestration' || value.startsWith('.orchestration/'))) continue;
    dirty.push(entry);
    if ((xy[0] === 'R' || xy[0] === 'C') && records[i + 1]) dirty.push(records[++i]);
  }
  return dirty;
}
function assertClean(root, execFile) { const dirty = status(root, execFile); if (dirty.length) throw new Error(`Git worktree is not clean: ${dirty.join(', ')}`); }
function assertTrackedTicket(workspace, ticketPath, execFile) {
  const raw = path.resolve(String(ticketPath));
  let stat; try { stat = fs.lstatSync(raw); } catch { throw new Error('Ticket does not exist.'); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Ticket must be a tracked, non-symlink file in the worktree.');
  const absolute = real(raw); const relative = path.relative(real(workspace), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Ticket path is outside the owned worktree.');
  try { runGit(workspace, ['ls-files', '--error-unmatch', '--', relative], execFile); } catch { throw new Error(`Ticket is not tracked in the worktree: ${relative}`); }
  return relative;
}
function worktreeBinding(root, workspace, expectedBranch, execFile) {
  const target = path.resolve(workspace); let stat; try { stat = fs.lstatSync(target); } catch { throw new Error('Owned workspace does not exist.'); }
  if (stat.isSymbolicLink()) throw new Error('Owned workspace is a symlink.');
  const lines = runGit(root, ['worktree', 'list', '--porcelain'], execFile).split(/\r?\n/); let found;
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('worktree ')) { const p = lines[i].slice(9); let b = ''; for (let j = i + 1; j < lines.length && lines[j]; j++) if (lines[j].startsWith('branch ')) b = lines[j].slice(7).replace(/^refs\/heads\//, ''); if (path.resolve(p) === target) found = { path: p, branch: b }; }
  if (!found || found.branch !== expectedBranch) throw new Error('Owned workspace is not bound to the expected worktree and branch.');
  return found;
}
function preflight({ root, ticketPath, workspace, sourceBranch, execFile = gitDefault } = {}) {
  const ticketRaw = path.resolve(String(ticketPath)); let ticketStat; try { ticketStat = fs.lstatSync(ticketRaw); } catch { throw new Error('Ticket does not exist.'); } if (ticketStat.isSymbolicLink()) throw new Error('Ticket must be a tracked, non-symlink file in the worktree.');
  const destinationRoot = real(root); const topLevel = gitTop(destinationRoot, execFile); if (destinationRoot !== topLevel) throw new Error(`Registered project root must equal Git top-level (${topLevel}).`);
  const destinationBranch = branch(destinationRoot, execFile); if (!destinationBranch) throw new Error('Destination must be on an attached Git branch.');
  assertClean(destinationRoot, execFile); const baseHead = head(destinationRoot, execFile); const workspacePath = path.resolve(String(workspace)); let workspaceStat; try { workspaceStat = fs.lstatSync(workspacePath); } catch { throw new Error('Owned workspace does not exist.'); }
  if (workspaceStat.isSymbolicLink()) throw new Error('Owned workspace is a symlink.'); const ownedWorkspace = real(workspacePath); if (gitTop(ownedWorkspace, execFile) !== ownedWorkspace) throw new Error('Owned workspace Git top-level does not equal its canonical path.');
  if (gitCommon(ownedWorkspace, execFile) !== gitCommon(destinationRoot, execFile)) throw new Error('Owned workspace belongs to a different Git repository.');
  const actualSourceBranch = branch(ownedWorkspace, execFile); if (sourceBranch && actualSourceBranch !== sourceBranch) throw new Error(`Expected source branch ${sourceBranch}, found ${actualSourceBranch || 'detached HEAD'}.`);
  if (actualSourceBranch) worktreeBinding(destinationRoot, ownedWorkspace, actualSourceBranch, execFile); assertClean(ownedWorkspace, execFile); const relativeTicket = assertTrackedTicket(ownedWorkspace, ticketPath, execFile);
  return { mode: 'worktree', phase: 'preflight', destinationRoot, topLevel, destinationBranch, baseHead, ownedWorkspace, sourceBranch: actualSourceBranch, sourceHead: head(ownedWorkspace, execFile), relativeTicket };
}
function captureReviewed({ metadata, ticketPath, execFile = gitDefault } = {}) {
  if (!metadata || metadata.mode !== 'worktree') throw new Error('Worktree integration metadata is required.'); const current = preflight({ root: metadata.destinationRoot, workspace: metadata.ownedWorkspace, sourceBranch: metadata.sourceBranch, ticketPath, execFile });
  if (current.sourceHead === metadata.baseHead) throw new Error('Source branch has no new commit beyond the captured destination base.'); try { runGit(metadata.ownedWorkspace, ['merge-base', '--is-ancestor', metadata.baseHead, current.sourceHead], execFile); } catch { throw new Error('Source HEAD does not descend from the captured base.'); }
  const sourceTicket = parseTicket(ticketPath, fs.readFileSync(ticketPath, 'utf8')); if (!['done', 'completed'].includes(sourceTicket.state) || sourceTicket.acceptanceCriteria.some((item) => !item.completed)) throw new Error('Source ticket is not completed with every acceptance criterion checked.');
  return { ...metadata, phase: 'pending_review', sourceHead: current.sourceHead, capturedAt: new Date().toISOString(), sourceTicketPath: ticketPath };
}
function lock(root, { isProcessAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error?.code === 'ESRCH') return false; throw error; } } } = {}) {
  const destinationRoot = real(root); const dir = path.join(destinationRoot, '.orchestration'); const file = path.join(dir, 'integration.lock');
  let dirStat; try { dirStat = fs.lstatSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; fs.mkdirSync(dir); dirStat = fs.lstatSync(dir); }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('Unsafe integration lock directory.');
  try { const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Unsafe integration lock path.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const acquire = () => { try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }), 'utf8'); fs.closeSync(fd); } catch (error) { if (error.code !== 'EEXIST') throw error; let owner; try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Object.assign(new Error('Integration lock is malformed; manual attention required.'), { code: 'INTEGRATION_LOCK_MALFORMED' }); } let live = true; try { live = Boolean(isProcessAlive(Number(owner.pid))); } catch { live = true; } if (live) throw Object.assign(new Error('Integration lock is held by a live owner; retry later.'), { code: 'INTEGRATION_LOCK_BUSY' }); try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token !== owner.token) throw new Error(); fs.unlinkSync(file); } catch { throw Object.assign(new Error('Could not recover stale integration lock safely.'), { code: 'INTEGRATION_LOCK_STALE' }); } acquire(); } };
  acquire(); return () => { try { const owner = JSON.parse(fs.readFileSync(file, 'utf8')); if (owner.token === token) fs.unlinkSync(file); } catch {} };
}
function exactParents(root, commit, execFile) { return runGit(root, ['rev-list', '--parents', '-n', '1', commit], execFile).split(/\s+/).slice(1); }
function authorizeMovedDestination(root, base, current, records = [], execFile = gitDefault) { if (base === current) return true; let commits; try { commits = runGit(root, ['rev-list', '--first-parent', `${base}..${current}`], execFile).split(/\r?\n/).filter(Boolean); } catch { return false; } const allowed = new Set(records.flatMap((record) => [record.mergeCommit, record.completionCommit, record.finalDestinationHead].filter(Boolean))); return commits.length > 0 && commits.every((commit) => allowed.has(commit)); }
function reconcileIntegration({ metadata, execFile = gitDefault } = {}) {
  if (!metadata?.destinationRoot || !metadata.sourceHead || !metadata.baseHead || !metadata.destinationBranch) throw new Error('Malformed integration metadata; manual attention required.');
  const gitDir = runGit(metadata.destinationRoot, ['rev-parse', '--git-dir'], execFile); const mergeHead = path.join(path.isAbsolute(gitDir) ? gitDir : path.join(metadata.destinationRoot, gitDir), 'MERGE_HEAD'); if (fs.existsSync(mergeHead)) throw new Error('Unresolved merge state requires manual attention.');
  const destinationHead = head(metadata.destinationRoot, execFile); const expectedBefore = metadata.destinationHeadBeforeMerge || metadata.baseHead;
  if (metadata.phase === 'integrated' && ((metadata.finalDestinationHead && destinationHead === metadata.finalDestinationHead) || (!metadata.finalDestinationHead && destinationHead === (metadata.destinationHead || metadata.mergeCommit)))) return metadata;
  if (metadata.phase === 'integrated') return metadata;
  if (['integrating', 'completing'].includes(metadata.phase) && destinationHead !== expectedBefore && exactParents(metadata.destinationRoot, destinationHead, execFile).join(' ') === `${expectedBefore} ${metadata.sourceHead}`) return { ...metadata, phase: metadata.phase === 'completing' ? 'completing' : 'completing', mergeCommit: metadata.mergeCommit || destinationHead, destinationHead };
  if (metadata.phase === 'completing' && metadata.mergeCommit && metadata.completionPaths?.length && destinationHead !== metadata.mergeCommit && exactParents(metadata.destinationRoot, destinationHead, execFile)[0] === metadata.mergeCommit) {
    const changed = runGit(metadata.destinationRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', destinationHead], execFile).split(/\r?\n/).filter(Boolean).sort();
    if (JSON.stringify(changed) === JSON.stringify([...metadata.completionPaths].sort())) return { ...metadata, phase: 'integrated', completionCommit: destinationHead, finalDestinationHead: destinationHead, integratedAt: new Date().toISOString() };
    throw new Error('Completion commit changed paths do not match persisted completion metadata.');
  }
  if (destinationHead !== expectedBefore) throw new Error('Integration state is unsafe: destination moved without exact recorded merge parents.');
  return { ...metadata, phase: metadata.phase === 'pending_review' ? 'pending_review' : 'integration_pending' };
}
function integrateReviewed({ metadata, execFile = gitDefault, persist, finalize, prepare } = {}) {
  if (!metadata?.sourceHead || !metadata.destinationRoot || !metadata.ownedWorkspace) throw new Error('Incomplete reviewed integration metadata.'); const release = lock(metadata.destinationRoot);
  try {
    const ticketPath = metadata.sourceTicketPath || path.join(metadata.ownedWorkspace, metadata.relativeTicket); const current = preflight({ root: metadata.destinationRoot, workspace: metadata.ownedWorkspace, sourceBranch: metadata.sourceBranch, ticketPath, execFile });
    if (current.destinationBranch !== metadata.destinationBranch || current.sourceHead !== metadata.sourceHead) throw new Error('Reviewed source or destination identity moved since review.');
    const existingHead = head(metadata.destinationRoot, execFile);
    const recovering = ['integrating', 'completing'].includes(metadata.phase) && metadata.destinationHeadBeforeMerge;
    const before = recovering ? metadata.destinationHeadBeforeMerge : current.baseHead;
    const exactExistingMerge = existingHead !== before && exactParents(metadata.destinationRoot, existingHead, execFile).join(' ') === `${before} ${metadata.sourceHead}`;
    const authorized = [...(metadata.authorizedCommits || []), metadata.mergeCommit ? { mergeCommit: metadata.mergeCommit } : null].filter(Boolean);
    if (!exactExistingMerge && !authorizeMovedDestination(metadata.destinationRoot, metadata.baseHead, before, authorized, execFile)) throw new Error('Destination HEAD moved without authoritative prior integration records.');
    let working = { ...metadata, phase: 'integration_pending', destinationHeadBeforeMerge: before }; persist?.(working); working = { ...working, phase: 'integrating' }; persist?.(working);
    let mergeCommit;
    if (exactExistingMerge) mergeCommit = existingHead;
    else { runGit(metadata.destinationRoot, ['merge', '--no-ff', '--no-edit', metadata.sourceHead], execFile); mergeCommit = head(metadata.destinationRoot, execFile); }
    const parents = exactParents(metadata.destinationRoot, mergeCommit, execFile); if (parents[0] !== before || parents[1] !== metadata.sourceHead) throw new Error('Merge did not produce the exact expected destination/source parents.');
    working = { ...working, phase: 'completing', mergeCommit, destinationHead: mergeCommit };
    if (typeof prepare === 'function') working = { ...working, ...(prepare(working) || {}) };
    persist?.(working);
    const completion = finalize ? (finalize(working) || {}) : {}; assertClean(metadata.destinationRoot, execFile);
    const finalHead = completion.finalDestinationHead || head(metadata.destinationRoot, execFile); const result = { ...working, ...completion, phase: 'integrated', mergeCommit, destinationHead: mergeCommit, finalDestinationHead: finalHead, integratedAt: new Date().toISOString() }; persist?.(result); Object.assign(metadata, result); return result;
  } finally { release(); }
}
module.exports = { runGit, status, assertClean, preflight, captureReviewed, reconcileIntegration, integrateReviewed, acquireIntegrationLock: lock, exactParents, authorizeMovedDestination };
