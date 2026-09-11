const fs = require('node:fs');
const path = require('node:path');
const { spawn: spawnProcess } = require('node:child_process');

function walkTickets(root) {
  const found = [];
  const tickets = path.join(root, '.tickets');
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(full);
    }
  }
  visit(tickets);
  return found;
}
function parseScalar(value) {
  const trimmed = String(value).trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
function frontmatter(markdown) {
  if (!markdown.startsWith('---')) return {};
  const end = markdown.indexOf('\n---', 3);
  if (end < 0) return {};
  const result = {};
  let listKey;
  markdown.slice(4, end).split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([\w-]+):\s*(.*)$/);
    if (match) {
      listKey = match[2] ? undefined : match[1];
      result[match[1]] = match[2] ? parseScalar(match[2]) : [];
    } else if (listKey && /^\s+-\s+/.test(line)) result[listKey].push(parseScalar(line.replace(/^\s+-\s+/, '')));
  });
  return result;
}
function parseMarkdown(filePath, markdown) {
  const metadata = frontmatter(markdown);
  const body = markdown.replace(/^---[\s\S]*?\n---\s*/, '');
  const lines = body.split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line));
  const title = String(metadata.title || (heading ? heading.replace(/^#\s+/, '').trim() : path.basename(filePath, '.md')));
  const criteria = lines.map((line, index) => {
    const match = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    return match ? { text: match[2].trim(), completed: match[1].toLowerCase() === 'x', line: index + 1 } : null;
  }).filter(Boolean);
  const objective = lines.filter((line) => !/^\s*[-*]\s+\[[ xX]\]/.test(line) && !/^#/.test(line) && line.trim()).slice(0, 4).join(' ').trim();
  const stat = fs.statSync(filePath);
  const id = String(metadata.id || path.basename(filePath, '.md'));
  const labels = Array.isArray(metadata.labels) ? metadata.labels.map(String) : metadata.labels ? String(metadata.labels).split(',').map((item) => item.trim()).filter(Boolean) : [];
  const status = String(metadata.state || metadata.status || (criteria.length && criteria.every((item) => item.completed) ? 'completed' : 'idle')).toLowerCase();
  return { id, cwd: rootFor(filePath), title, objective: String(metadata.objective || objective || title), summary: `${criteria.filter((item) => item.completed).length}/${criteria.length} acceptance criteria complete`, status, priority: metadata.priority ? String(metadata.priority) : undefined, labels, updatedAt: stat.mtime.toISOString(), createdAt: stat.birthtime.toISOString(), filePath, acceptanceCriteria: criteria };
}
function rootFor(filePath) { const marker = `${path.sep}.tickets${path.sep}`; const at = path.resolve(filePath).indexOf(marker); return at >= 0 ? path.resolve(filePath).slice(0, at) : path.dirname(path.resolve(filePath)); }
class PiMarkdownProvider {
  constructor({ roots = [], spawn = spawnProcess } = {}) { this.roots = roots; this.spawn = spawn; this.children = new Map(); this.runtimeStatuses = new Map(); }
  listTickets() { return [...new Set(this.roots.flatMap(walkTickets))].map((file) => parseMarkdown(file, fs.readFileSync(file, 'utf8'))).map((ticket) => ({ ...ticket, ...(this.runtimeStatuses.has(ticket.id) ? { status: this.runtimeStatuses.get(ticket.id) } : {}) })); }
  snapshot() { return { connected: true, provider: 'pi', tickets: this.listTickets(), projects: this.roots }; }
  resolveTicket(value) { const input = path.resolve(String(value)); const ticket = this.listTickets().find((item) => item.id === String(value) || path.resolve(item.filePath) === input); if (!ticket) throw new Error('Pi ticket was not found in a registered project root.'); return ticket; }
  readTicket(value) { const ticket = this.resolveTicket(value); const markdown = fs.readFileSync(ticket.filePath, 'utf8'); return { provider: 'pi', threadId: ticket.id, status: ticket.status, updatedAt: ticket.updatedAt, items: [{ id: 'ticket-markdown', kind: 'message', role: 'user', text: markdown, timestamp: ticket.updatedAt }], ticket }; }
  createTicket({ cwd, title, objective = '', acceptanceCriteria = [] }) { this.assertRoot(cwd); const dir = path.join(cwd, '.tickets'); fs.mkdirSync(dir, { recursive: true }); const safe = String(title || 'ticket').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ticket'; let file = path.join(dir, `${safe}.md`); let n = 2; while (fs.existsSync(file)) file = path.join(dir, `${safe}-${n++}.md`); const criteria = acceptanceCriteria.map((item) => `- [ ] ${String(item)}`).join('\n'); fs.writeFileSync(file, `# ${String(title || 'Untitled ticket').trim()}\n\n${String(objective).trim()}\n${criteria ? `\n## Acceptance criteria\n${criteria}\n` : ''}`, 'utf8'); return parseMarkdown(file, fs.readFileSync(file, 'utf8')); }
  updateTicket({ filePath, title, objective, acceptanceCriteria }) { const currentTicket = this.resolveTicket(filePath); const current = fs.readFileSync(currentTicket.filePath, 'utf8'); const ticket = parseMarkdown(currentTicket.filePath, current); const criteria = acceptanceCriteria === undefined ? ticket.acceptanceCriteria : acceptanceCriteria.map((item, index) => { const text = typeof item === 'object' && item ? String(item.text) : String(item); const explicit = typeof item === 'object' && item ? Boolean(item.completed) : undefined; const previous = ticket.acceptanceCriteria.find((candidate) => candidate.text === text) || ticket.acceptanceCriteria[index]; return { text, completed: explicit === undefined ? Boolean(previous?.completed) : explicit }; }); fs.writeFileSync(currentTicket.filePath, `---\nid: ${ticket.id}\n---\n# ${title === undefined ? ticket.title : title}\n\n${objective === undefined ? ticket.objective : objective}\n\n## Acceptance criteria\n${criteria.map((item) => `- [${item.completed ? 'x' : ' '}] ${item.text}`).join('\n')}\n`, 'utf8'); return parseMarkdown(currentTicket.filePath, fs.readFileSync(currentTicket.filePath, 'utf8')); }
  appendRun(event, cwd) { const dir = path.join(cwd, '.orchestration'); fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, 'runs.jsonl'), `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`); }
  dispatch(value) { const ticket = this.resolveTicket(value); if (this.children.has(ticket.id)) return { dispatched: false, filePath: ticket.filePath, id: ticket.id, running: true }; const prompt = `${ticket.title}\n\n${ticket.objective}\n\nAcceptance criteria:\n${ticket.acceptanceCriteria.map((item) => `- ${item.text}`).join('\n')}`; const child = this.spawn('pi', ['--mode', 'json', '--no-session', '--model', 'openai/gpt-5.6-luna', '--thinking', 'medium', '-p', prompt], { cwd: ticket.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); this.children.set(ticket.id, child); this.runtimeStatuses.set(ticket.id, 'running'); this.appendRun({ event: 'started', ticketId: ticket.id, filePath: ticket.filePath, pid: child.pid }, ticket.cwd); const output = (chunk) => { const text = String(chunk); this.appendRun({ event: 'output', ticketId: ticket.id, output: text.slice(-10000) }, ticket.cwd); }; child.stdout?.on('data', output); child.stderr?.on('data', output); child.once('close', (code, signal) => { this.children.delete(ticket.id); if (this.runtimeStatuses.get(ticket.id) === 'running') this.runtimeStatuses.set(ticket.id, code === 0 ? 'completed' : 'failed'); this.appendRun({ event: 'finished', ticketId: ticket.id, code, signal }, ticket.cwd); }); return { dispatched: true, id: ticket.id, filePath: ticket.filePath, pid: child.pid }; }
  async interrupt(value, { timeoutMs = 1500, killTimeoutMs = 1000 } = {}) { const ticket = this.resolveTicket(value); const child = this.children.get(ticket.id); if (!child) return { interrupted: false, id: ticket.id, filePath: ticket.filePath }; this.runtimeStatuses.set(ticket.id, 'waiting'); this.appendRun({ event: 'interrupted', ticketId: ticket.id }, ticket.cwd); const exited = new Promise((resolve) => child.once('close', resolve)); try { child.kill('SIGTERM'); } catch {} let closed = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))]); if (!closed && this.children.get(ticket.id) === child) { try { child.kill('SIGKILL'); } catch {} closed = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), killTimeoutMs))]); } return { interrupted: true, id: ticket.id, filePath: ticket.filePath, forced: !closed }; }
  assertRoot(target) { const resolved = path.resolve(target); if (!this.roots.some((root) => resolved === path.resolve(root) || resolved.startsWith(`${path.resolve(root)}${path.sep}`))) throw new Error('Ticket path is outside a registered project root.'); }
}
module.exports = { PiMarkdownProvider, parseMarkdown, walkTickets };
