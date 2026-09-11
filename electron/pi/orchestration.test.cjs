const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseWorkflow } = require('./workflow.cjs');
const { parseTicket, updateTicketAtomic } = require('./tickets.cjs');
const { loadState, saveState, reconcileState } = require('./state.cjs');

function project() { return fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-orch-')); }
test('workflow defaults and hard concurrency cap', () => { const root = project(); fs.writeFileSync(path.join(root, 'WORKFLOW.md'), '---\nmaxConcurrent: 9\nautoReview: false\nworkspaceMode: worktree\n---\nDo the work.\n'); const workflow = parseWorkflow(root); assert.equal(workflow.maxConcurrent, 3); assert.equal(workflow.autoReview, false); assert.equal(workflow.workspaceMode, 'worktree'); assert.equal(workflow.instructions, 'Do the work.'); });
test('unsupported workflow model overrides fail explicitly', () => {
  for (const key of ['plannerModel', 'workerModel', 'reviewerModel']) {
    const root = project();
    fs.writeFileSync(path.join(root, 'WORKFLOW.md'), `---\n${key}: openai-codex/unsupported\n---\n`);
    assert.throws(() => parseWorkflow(root), new RegExp(`Unsupported Pi workflow model override for ${key}`));
  }
});
test('dependency eligibility data and atomic transitions preserve markdown', () => { const root = project(); const file = path.join(root, 'ticket.md'); fs.writeFileSync(file, '---\nid: T-1\nparentId: P-1\nblockedBy:\n  - T-0\ncustom: keep\n---\n# Title\n\nImportant body text.\n\n- [x] First\n- [ ] Second\n'); const ticket = parseTicket(file, fs.readFileSync(file, 'utf8')); assert.deepEqual(ticket.blockedBy, ['T-0']); const updated = updateTicketAtomic(file, { state: 'review', acceptanceCriteria: ['First', { text: 'Second', completed: true }] }); assert.equal(updated.state, 'review'); const text = fs.readFileSync(file, 'utf8'); assert.match(text, /custom: keep/); assert.match(text, /Important body text/); assert.match(text, /- \[x\] Second/); });
test('state persistence and stale running reconciliation are conservative', () => { const root = project(); const state = loadState(root); state.claims.one = { status: 'running', pid: 123456, phase: 'worker' }; saveState(root, state); const reconciled = reconcileState(root); assert.equal(reconciled.claims.one.status, 'stale'); assert.match(reconciled.claims.one.error, /not alive/); });
