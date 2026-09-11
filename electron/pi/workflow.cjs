const fs = require('node:fs');
const path = require('node:path');

const PI_WORKFLOW_MODELS = Object.freeze({ plannerModel: 'openai-codex/gpt-5.6-sol', workerModel: 'openai-codex/gpt-5.6-luna', reviewerModel: 'openai-codex/gpt-5.6-luna' });
const DEFAULT_WORKFLOW = Object.freeze({ maxConcurrent: 2, ...PI_WORKFLOW_MODELS, plannerThinking: 'xhigh', workerThinking: 'medium', reviewerThinking: 'medium', autoReview: true, workspaceMode: 'root', retryMax: 2 });
function scalar(value) {
  const text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  if (text === 'true' || text === 'false') return text === 'true';
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}
function parseYamlFrontmatter(text) {
  if (!String(text).startsWith('---')) return {};
  const end = String(text).search(/\r?\n---(?:\r?\n|$)/);
  if (end < 0) return {};
  const out = {}; let list;
  String(text).slice(4, end).split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([A-Za-z][\w-]*):\s*(.*)$/);
    if (match) { list = match[2] ? undefined : match[1]; out[match[1]] = match[2] ? scalar(match[2]) : []; }
    else if (list && /^\s*-\s+/.test(line)) out[list].push(scalar(line.replace(/^\s*-\s+/, '')));
  });
  return out;
}
function parseWorkflow(root) {
  const filePath = path.join(path.resolve(root), 'WORKFLOW.md');
  let text = ''; try { text = fs.readFileSync(filePath, 'utf8'); } catch {}
  const raw = parseYamlFrontmatter(text);
  for (const [key, expected] of Object.entries(PI_WORKFLOW_MODELS)) {
    if (raw[key] !== undefined && raw[key] !== expected) throw new Error(`Unsupported Pi workflow model override for ${key}: ${String(raw[key])}. Expected ${expected}.`);
  }
  const max = Math.max(1, Math.min(3, Number(raw.maxConcurrent ?? DEFAULT_WORKFLOW.maxConcurrent) || DEFAULT_WORKFLOW.maxConcurrent));
  const retryMax = Math.max(0, Math.min(10, Number(raw.retryMax ?? DEFAULT_WORKFLOW.retryMax) || 0));
  return { ...DEFAULT_WORKFLOW, ...raw, maxConcurrent: max, retryMax, autoReview: raw.autoReview === undefined ? true : Boolean(raw.autoReview), workspaceMode: raw.workspaceMode === 'worktree' ? 'worktree' : 'root', instructions: text.replace(/^---[\s\S]*?\r?\n---\s*/, '').trim(), filePath };
}
module.exports = { DEFAULT_WORKFLOW, PI_WORKFLOW_MODELS, parseYamlFrontmatter, parseWorkflow };
