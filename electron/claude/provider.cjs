'use strict';

const { EventEmitter } = require('node:events');
const { spawn: defaultSpawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

class ClaudeCodeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ClaudeCodeError';
    Object.assign(this, details);
  }
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part.text === 'string') return part.text;
    if (part && part.type === 'tool_result' && typeof part.content === 'string') return part.content;
    return '';
  }).filter(Boolean).join('\n');
}

function recordText(record) {
  return textFromContent(record?.message?.content) || textFromContent(record?.content) ||
    (typeof record?.text === 'string' ? record.text : '');
}

function firstUserText(records) {
  const named = [...records].reverse().find((record) => record.type === 'ai-title' && (record.title || record.text));
  if (named) return String(named.title || named.text).trim().slice(0, 180);
  const item = records.find((record) => record.type === 'user' && recordText(record).trim());
  return recordText(item).replace(/<[^>]+>/g, '').trim().slice(0, 180) || 'Untitled session';
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isImage(filePath) {
  return /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|tiff?)$/i.test(filePath);
}

function extractFiles(records) {
  const paths = new Set();
  const source = records.map(recordText).join('\n');
  // Paths in Claude's IDE-selection wrapper can contain spaces. Capture media
  // paths by extension before falling back to whitespace-delimited paths.
  for (const match of source.matchAll(/((?:\/|~\/)[^\n<>"'`]+?\.(?:png|jpe?g|gif|webp|avif|svg|bmp|tiff?|pdf|md|txt|tsx?|jsx?|py|json))(?:[),.;:]|\s|$)/gi)) {
    const candidate = match[1].trim();
    paths.add(candidate.startsWith('~/') ? path.join(os.homedir(), candidate.slice(2)) : candidate);
  }
  for (const match of source.matchAll(/(?:^|[\s(`])((?:\/|~\/)[^\s)`<>"']+)/g)) {
    const candidate = match[1].replace(/[.,;:]+$/, '');
    const expanded = candidate.startsWith('~/') ? path.join(os.homedir(), candidate.slice(2)) : candidate;
    paths.add(expanded);
  }
  return [...paths].map((filePath) => ({ path: filePath, kind: isImage(filePath) ? 'image' : 'file' }));
}

async function readJsonLines(filePath) {
  let source;
  try { source = await fsp.readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return [];
    throw error;
  }
  const records = [];
  for (const [lineNumber, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch { records.push({ type: 'parse-error', lineNumber: lineNumber + 1, raw: line }); }
  }
  return records;
}

async function findJsonLines(directory) {
  const files = [];
  let entries;
  try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'EACCES') return files; throw error; }
  for (const entry of entries) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findJsonLines(item));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(item);
  }
  return files;
}

function sessionFromRecords(filePath, records) {
  if (!records.length) return null;
  const first = records.find((r) => r.sessionId) || records[0];
  const sidechainPath = filePath.includes(`${path.sep}subagents${path.sep}`);
  const agentId = records.find((r) => r.agentId)?.agentId;
  const sessionId = sidechainPath ? agentId || path.basename(filePath, '.jsonl') : first.sessionId || path.basename(filePath, '.jsonl');
  const cwd = records.find((r) => typeof r.cwd === 'string')?.cwd || null;
  const timestamps = records.map((r) => r.timestamp).filter(Boolean).map((v) => new Date(v).getTime()).filter(Number.isFinite);
  const model = records.find((r) => r.message?.model)?.message.model || records.find((r) => r.model)?.model || null;
  const last = records[records.length - 1];
  const parent = records.find((r) => r.parentSessionId || r.parentThreadId)?.parentSessionId ||
    records.find((r) => r.parentSessionId || r.parentThreadId)?.parentThreadId ||
    (sidechainPath ? path.basename(path.dirname(path.dirname(filePath))) : null);
  const sidechain = sidechainPath || records.some((r) => r.isSidechain === true);
  return {
    id: sessionId,
    provider: 'claude',
    title: firstUserText(records),
    cwd,
    project: cwd ? path.basename(cwd) : path.basename(path.dirname(filePath)),
    model,
    createdAt: iso(timestamps.length ? Math.min(...timestamps) : null),
    updatedAt: iso(timestamps.length ? Math.max(...timestamps) : null),
    status: last.type === 'result' || last.type === 'summary' ? 'completed' : 'idle',
    parentSessionId: parent,
    isSidechain: sidechain,
    transcriptPath: filePath,
    files: extractFiles(records),
  };
}

class ClaudeCodeProvider extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.command || 'claude';
    this.home = options.home || os.homedir();
    this.claudeDir = options.claudeDir || path.join(this.home, '.claude');
    this.projectsDir = options.projectsDir || path.join(this.claudeDir, 'projects');
    this.spawn = options.spawn || defaultSpawn;
    this.children = new Map();
    this.runtimeStatuses = new Map();
    this.liveRecords = new Map();
    this.capabilities = { archive: false, delete: true, rename: false, resume: true, start: true, historyDestructiveDelete: true };
  }

  async listProjects() {
    let entries;
    try { entries = await fsp.readdir(this.projectsDir, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') return [];
      throw error;
    }
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.projectsDir, entry.name);
      const files = await findJsonLines(dir);
      const sessions = [];
      for (const file of files) {
        const filePath = path.isAbsolute(file) ? file : path.join(dir, file);
        const session = sessionFromRecords(filePath, await readJsonLines(filePath));
        if (session) sessions.push(session);
      }
      if (!sessions.length) continue;
      const cwd = sessions.find((s) => s.cwd)?.cwd || null;
      projects.push({ id: entry.name, name: cwd ? path.basename(cwd) : entry.name, cwd, sessions });
    }
    projects.sort((a, b) => (b.sessions[0]?.updatedAt || '').localeCompare(a.sessions[0]?.updatedAt || ''));
    return projects;
  }

  async listSessions(options = {}) {
    const projects = await this.listProjects();
    let sessions = projects.flatMap((project) => project.sessions);
    if (options.cwd) sessions = sessions.filter((session) => session.cwd === options.cwd || session.cwd?.startsWith(`${options.cwd}${path.sep}`));
    sessions = sessions.map((session) => ({ ...session, runtimeStatus: this.runtimeStatuses.get(session.id) || session.status, status: this.runtimeStatuses.get(session.id) || session.status }));
    return sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  async readSession(sessionId) {
    const sessions = await this.listSessions();
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) throw new ClaudeCodeError(`Claude session not found: ${sessionId}`, { sessionId });
    const stored = await readJsonLines(session.transcriptPath);
    const merged = new Map();
    stored.forEach((record, index) => merged.set(String(record.uuid || record.message?.id || `stored-${index}`), record));
    (this.liveRecords.get(sessionId) || []).forEach((record, index) => merged.set(String(record.uuid || record.message?.id || `live-${index}`), record));
    const records = [...merged.values()].sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    return { ...session, runtimeStatus: this.runtimeStatuses.get(sessionId) || session.runtimeStatus || session.status, records, messages: records.filter((r) => r.type === 'user' || r.type === 'assistant').map((r) => ({ id: r.uuid || null, role: r.type, text: recordText(r), timestamp: iso(r.timestamp), raw: r })), files: extractFiles(records) };
  }

  isRunning(sessionId) {
    const id = String(sessionId || '');
    return Boolean(id && this.children.get(id) && !this.children.get(id).closed);
  }

  async interruptSession(sessionId, { timeoutMs = 1500, killTimeoutMs = 1000 } = {}) {
    const id = String(sessionId || '');
    const handle = this.children.get(id);
    if (!handle || handle.closed) {
      if (this.runtimeStatuses.get(id) === 'running') {
        throw new ClaudeCodeError(`Claude session ${id} is active but is not owned by this Constellation process; refusing to signal an external process`, { sessionId: id, external: true });
      }
      return { interrupted: false, sessionId: id, mode: 'turn' };
    }
    handle.interrupted = true;
    this.runtimeStatuses.set(id, 'interrupted');
    const exitPromise = handle.exitPromise;
    try { handle.child.kill('SIGINT'); } catch (error) { handle.emit('stderr', `Could not interrupt Claude session: ${error.message}`); }
    let exited = await Promise.race([exitPromise, new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
    if (!exited && !handle.closed) {
      try { handle.child.kill('SIGTERM'); } catch {}
      exited = await Promise.race([exitPromise, new Promise((resolve) => setTimeout(() => resolve(null), killTimeoutMs))]);
    }
    if (!exited && !handle.closed) {
      try { handle.child.kill('SIGKILL'); } catch {}
      exited = await exitPromise;
    }
    return { interrupted: true, sessionId: id, mode: 'interrupt' };
  }

  startSession({ cwd, prompt, name, model, sessionId, resume = false, extraArgs = [] } = {}) {
    if (!cwd || !path.isAbsolute(cwd)) throw new ClaudeCodeError('A valid absolute cwd is required');
    if (!prompt || typeof prompt !== 'string') throw new ClaudeCodeError('A non-empty prompt is required');
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (name) args.push('--name', name);
    if (model) args.push('--model', model);
    if (sessionId || resume) args.push('--resume', sessionId || '');
    args.push(...extraArgs);
    const child = this.spawn(this.command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const handle = new EventEmitter();
    handle.child = child;
    handle.sessionId = sessionId || null;
    handle.interrupted = false;
    handle.closed = false;
    handle.exitPromise = new Promise((resolve) => handle.once('exit', resolve));
    if (sessionId) this.runtimeStatuses.set(sessionId, 'running');
    const setSessionId = (nextSessionId) => {
      if (!nextSessionId || handle.sessionId === nextSessionId) return;
      const oldKey = handle.sessionId || child.pid;
      handle.sessionId = String(nextSessionId);
      if (this.children.get(oldKey) === handle) this.children.delete(oldKey);
      this.children.set(handle.sessionId, handle);
      this.runtimeStatuses.set(handle.sessionId, 'running');
    };
    let buffer = '';
    const emitLines = (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { event = { type: 'text', text: line }; }
        if (event.session_id) setSessionId(event.session_id);
        if (handle.sessionId) {
          const failed = event.type === 'result' && (/error|fail/.test(String(event.subtype || '').toLowerCase()) || event.is_error === true);
          if (!handle.interrupted) this.runtimeStatuses.set(handle.sessionId, event.type === 'result' ? (failed ? 'failed' : 'completed') : 'running');
          const records = this.liveRecords.get(handle.sessionId) || [];
          records.push(event);
          if (records.length > 300) records.splice(0, records.length - 300);
          this.liveRecords.set(handle.sessionId, records);
        }
        handle.emit('event', event);
        this.emit('event', { ...event, provider: 'claude', cwd, sessionId: handle.sessionId });
      }
    };
    child.stdout.on('data', emitLines);
    child.stderr.on('data', (chunk) => handle.emit('stderr', String(chunk)));
    child.on('error', (error) => { if (!handle.interrupted && handle.sessionId) this.runtimeStatuses.set(handle.sessionId, 'failed'); handle.emit('error', error); if (!handle.interrupted) this.emit('error', error); });
    child.on('close', (code, signal) => {
      if (handle.closed) return;
      handle.closed = true;
      if (handle.sessionId && !handle.interrupted && this.runtimeStatuses.get(handle.sessionId) === 'running') this.runtimeStatuses.set(handle.sessionId, code === 0 ? 'completed' : 'failed');
      if (handle.sessionId && handle.interrupted) this.runtimeStatuses.set(handle.sessionId, 'interrupted');
      this.children.delete(handle.sessionId || child.pid);
      const exit = { code, signal, sessionId: handle.sessionId, interrupted: handle.interrupted };
      handle.emit('exit', exit);
      this.emit('exit', exit);
    });
    this.children.set(handle.sessionId || child.pid, handle);
    return handle;
  }

  resumeSession(sessionId, prompt, options = {}) { return this.startSession({ ...options, sessionId, prompt, resume: true }); }

  async archiveSession() { throw new ClaudeCodeError('Claude Code has no supported archive API; session remains recoverable in local history', { capability: 'archive', supported: false }); }

  async deleteSession(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) throw new ClaudeCodeError('A Claude session id is required for deletion.', { capability: 'delete' });

    // Discovery remains read-only. This explicit endpoint is the sole path that
    // may unlink provider history, and it only operates on this inventory.
    const sessions = await this.listSessions();
    const byId = new Map();
    for (const session of sessions) {
      if (!session?.id || byId.has(String(session.id))) {
        if (session?.id) throw new ClaudeCodeError(`Claude session inventory is ambiguous for ${session.id}; refusing deletion.`, { capability: 'delete' });
        continue;
      }
      byId.set(String(session.id), session);
    }
    const selected = byId.get(id);
    if (!selected) throw new ClaudeCodeError(`Claude session not found: ${id}`, { sessionId: id, capability: 'delete' });

    const descendants = new Map([[id, selected]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const session of sessions) {
        const parent = session.parentSessionId == null ? '' : String(session.parentSessionId);
        if (parent && descendants.has(parent) && !descendants.has(String(session.id))) {
          descendants.set(String(session.id), session);
          changed = true;
        }
      }
    }
    for (const descendant of descendants.values()) {
      const descendantId = String(descendant.id);
      if (this.isRunning(descendantId) || this.runtimeStatuses.get(descendantId) === 'running') {
        throw new ClaudeCodeError(`Stop Claude session ${descendantId} before deleting it; running sessions are not deleted.`, { sessionId: descendantId, capability: 'delete', running: true });
      }
    }

    let canonicalProjectsDir;
    try { canonicalProjectsDir = await fsp.realpath(this.projectsDir); }
    catch (error) { throw new ClaudeCodeError(`Cannot verify Claude history location: ${error.message}`, { capability: 'delete' }); }
    const rootPrefix = `${canonicalProjectsDir}${path.sep}`;
    const validated = [];
    for (const session of descendants.values()) {
      const transcriptPath = session.transcriptPath;
      if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath) || !transcriptPath.toLowerCase().endsWith('.jsonl')) {
        throw new ClaudeCodeError(`Claude session ${session.id} has an invalid transcript path; refusing deletion.`, { sessionId: String(session.id), capability: 'delete' });
      }
      const absolute = path.resolve(transcriptPath);
      let stat;
      try {
        stat = await fsp.lstat(absolute);
      } catch (error) {
        if (error.code === 'ENOENT') {
          // macOS commonly exposes /private/var through the /var alias. For an
          // already-missing file, resolve its existing parent before applying
          // containment; never trust the unresolved lexical alias by itself.
          let parentRealPath;
          try { parentRealPath = await fsp.realpath(path.dirname(absolute)); }
          catch (parentError) { throw new ClaudeCodeError(`Cannot verify Claude transcript for ${session.id}: ${parentError.message}`, { sessionId: String(session.id), capability: 'delete' }); }
          if (parentRealPath !== canonicalProjectsDir && !parentRealPath.startsWith(rootPrefix)) {
            throw new ClaudeCodeError(`Claude transcript for ${session.id} is outside the canonical projects directory; refusing deletion.`, { sessionId: String(session.id), capability: 'delete' });
          }
          validated.push({ id: String(session.id), path: absolute, missing: true });
          continue;
        }
        throw new ClaudeCodeError(`Cannot verify Claude transcript for ${session.id}: ${error.message}`, { sessionId: String(session.id), capability: 'delete' });
      }
      if (stat.isSymbolicLink() || !stat.isFile()) throw new ClaudeCodeError(`Claude transcript for ${session.id} is not a regular file; refusing deletion.`, { sessionId: String(session.id), capability: 'delete' });
      let realPath;
      try { realPath = await fsp.realpath(absolute); }
      catch (error) { throw new ClaudeCodeError(`Cannot verify Claude transcript for ${session.id}: ${error.message}`, { sessionId: String(session.id), capability: 'delete' }); }
      if (!realPath.startsWith(rootPrefix) || !realPath.toLowerCase().endsWith('.jsonl')) {
        throw new ClaudeCodeError(`Claude transcript for ${session.id} is outside the canonical projects directory; refusing deletion.`, { sessionId: String(session.id), capability: 'delete' });
      }
      validated.push({ id: String(session.id), path: absolute, missing: false });
    }
    // Delete descendants before parents so a malformed/partial sidechain tree
    // cannot leave a parent file as an accidental source of stale context.
    const depth = (session) => {
      let value = 0;
      let parent = session.parentSessionId == null ? '' : String(session.parentSessionId);
      const seen = new Set();
      while (parent && descendants.has(parent) && !seen.has(parent)) {
        seen.add(parent); value += 1; parent = descendants.get(parent).parentSessionId == null ? '' : String(descendants.get(parent).parentSessionId);
      }
      return value;
    };
    validated.sort((a, b) => depth(descendants.get(b.id)) - depth(descendants.get(a.id)));
    let deletedPathsCount = 0;
    for (const item of validated) {
      if (item.missing) continue;
      try {
        await fsp.unlink(item.path);
        deletedPathsCount += 1;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw new ClaudeCodeError(`Could not delete Claude transcript for ${item.id}: ${error.message}`, { sessionId: item.id, capability: 'delete' });
      }
    }
    const deletedSessionIds = [...descendants.keys()];
    deletedSessionIds.forEach((deletedId) => {
      this.runtimeStatuses.delete(deletedId);
      this.liveRecords.delete(deletedId);
      const handle = this.children.get(deletedId);
      if (handle && handle.closed) this.children.delete(deletedId);
    });
    return { deleted: true, sessionId: id, deletedSessionIds, deletedPathsCount };
  }
}

module.exports = { ClaudeCodeProvider, ClaudeCodeError, readJsonLines, sessionFromRecords, extractFiles };
