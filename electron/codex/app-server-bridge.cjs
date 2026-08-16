'use strict';

const { EventEmitter } = require('node:events');
const { spawn: defaultSpawn } = require('node:child_process');

const ALL_SOURCE_KINDS = [
  'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown',
];

class CodexAppServerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CodexAppServerError';
    Object.assign(this, details);
  }
}

/**
 * JSON-RPC/JSONL client for `codex app-server --stdio`.
 * The process is intentionally owned by this class; no Codex storage is read.
 */
class CodexAppServerBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.command || 'codex';
    this.args = options.args || ['app-server', '--stdio'];
    this.cwd = options.cwd;
    this.env = options.env;
    this.requestTimeoutMs = options.requestTimeoutMs || 30000;
    this.spawn = options.spawn || defaultSpawn;
    this.autoRestart = options.autoRestart === true;
    this.restartDelayMs = options.restartDelayMs || 250;
    this._nextId = 1;
    this._pending = new Map();
    this._buffer = '';
    this._child = null;
    this._closed = false;
    this._initialized = false;
    this._restartTimer = null;
    this._connectOptions = null;
  }

  get connected() { return Boolean(this._child) && !this._closed; }

  async connect({ clientInfo, capabilities } = {}) {
    if (this.connected && this._initialized) return this;
    this._closed = false;
    this._connectOptions = { clientInfo, capabilities };
    this._spawn();
    const result = await this.request('initialize', {
      clientInfo: clientInfo || { name: 'constellation', title: 'Constellation', version: '0.1.0' },
      capabilities: capabilities || { experimentalApi: true, requestAttestation: false },
    });
    this._send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    this._initialized = true;
    this.emit('ready', result);
    return this;
  }

  _spawn() {
    this._buffer = '';
    this._child = this.spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env ? { ...process.env, ...this.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._child.stdout.on('data', (chunk) => this._onData(chunk));
    this._child.stderr.on('data', (chunk) => this.emit('stderr', String(chunk)));
    this._child.on('error', (error) => this._failAll(new CodexAppServerError(`Codex app-server failed to start: ${error.message}`, { cause: error })));
    this._child.on('close', (code, signal) => {
      const error = new CodexAppServerError(`Codex app-server exited (${signal || code})`, { code, signal });
      this._child = null;
      this._initialized = false;
      this._failAll(error);
      this.emit('exit', { code, signal, error });
      if (!this._closed && this.autoRestart) {
        clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(() => this.connect(this._connectOptions || {}).catch((e) => this.emit('error', e)), this.restartDelayMs);
      }
    });
  }

  _onData(chunk) {
    this._buffer += String(chunk);
    const lines = this._buffer.split(/\r?\n/);
    this._buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch (cause) {
        this.emit('protocolError', new CodexAppServerError('Invalid JSONL from Codex app-server', { cause, line }));
        continue;
      }
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const pending = this._pending.get(String(message.id));
        if (!pending) continue;
        this._pending.delete(String(message.id));
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new CodexAppServerError(message.error.message || 'Codex request failed', { rpcError: message.error, method: pending.method }));
        else pending.resolve(message.result);
      } else if (message.method) {
        this.emit('notification', message);
        this.emit(message.method, message.params);
      }
    }
  }

  _send(message) {
    if (!this.connected || !this._child.stdin.writable) throw new CodexAppServerError('Codex app-server is not connected');
    const { jsonrpc: _jsonrpc, ...wireMessage } = message;
    this._child.stdin.write(`${JSON.stringify(wireMessage)}\n`);
  }

  request(method, params = {}) {
    if (!this.connected) return Promise.reject(new CodexAppServerError('Codex app-server is not connected'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(String(id));
        reject(new CodexAppServerError(`Timed out waiting for ${method}`, { method, id }));
      }, this.requestTimeoutMs);
      this._pending.set(String(id), { resolve, reject, timer, method });
      try { this._send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this._pending.delete(String(id)); reject(error); }
    });
  }

  async listThreads(options = {}) {
    const sourceKinds = !options.sourceKinds || options.sourceKinds.length === 0 ? ALL_SOURCE_KINDS : options.sourceKinds;
    const archivedValues = options.archived === undefined ? [false, true] : [options.archived];
    const all = [];
    for (const archived of archivedValues) {
      let cursor = options.cursor || null;
      do {
        const params = { ...options, archived, sourceKinds, cursor };
        delete params.all;
        const page = await this.request('thread/list', params);
        all.push(...(page?.data || page?.threads || []).map((thread) => ({ ...thread, archived })));
        cursor = page?.nextCursor ?? page?.next_cursor ?? null;
      } while (cursor && options.all !== false);
    }
    const seen = new Set();
    return all.filter((thread) => { const id = thread.id || thread.threadId; if (!id || seen.has(id)) return false; seen.add(id); return true; });
  }

  readThread(threadId, options = {}) { return this.request('thread/read', { threadId, ...options }); }
  startThread(params = {}) { return this.request('thread/start', params); }
  resumeThread(threadId, params = {}) { return this.request('thread/resume', { threadId, ...params }); }
  startTurn(threadId, input, params = {}) {
    const items = typeof input === 'string'
      ? [{ type: 'text', text: input, text_elements: [] }]
      : Array.isArray(input) ? input : [];
    return this.request('turn/start', {
      threadId,
      input: items,
      ...params,
    });
  }
  steerTurn(threadId, turnId, input) {
    const items = typeof input === 'string'
      ? [{ type: 'text', text: input, text_elements: [] }]
      : Array.isArray(input) ? input : [];
    return this.request('turn/steer', { threadId, expectedTurnId: turnId, input: items });
  }
  setThreadName(threadId, name) { return this.request('thread/setName', { threadId, name }); }
  updateThreadSettings(threadId, params = {}) { return this.request('thread/settings/update', { threadId, ...params }); }
  archiveThread(threadId) { return this.request('thread/archive', { threadId }); }
  unarchiveThread(threadId) { return this.request('thread/unarchive', { threadId }); }
  deleteThread(threadId) { return this.request('thread/delete', { threadId }); }
  pinThread(threadId, sectionId, beforeThreadId = null) { return this.request('thread/section/move', { threadId, sectionId, beforeThreadId }); }
  unpinThread(threadId) { return this.request('thread/section/move', { threadId, sectionId: null }); }

  // Short aliases keep the API pleasant to use from an Electron IPC handler.
  list(options) { return this.listThreads(options); }
  read(threadId, options) { return this.readThread(threadId, options); }
  start(params) { return this.startThread(params); }
  archive(threadId) { return this.archiveThread(threadId); }
  unarchive(threadId) { return this.unarchiveThread(threadId); }
  pin(threadId, sectionId, beforeThreadId) { return this.pinThread(threadId, sectionId, beforeThreadId); }
  unpin(threadId) { return this.unpinThread(threadId); }

  close() {
    this._closed = true;
    clearTimeout(this._restartTimer);
    this._restartTimer = null;
    if (this._child) this._child.kill();
    this._child = null;
    this._initialized = false;
    this._failAll(new CodexAppServerError('Codex app-server bridge closed'));
  }

  _failAll(error) {
    for (const pending of this._pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this._pending.clear();
  }
}

module.exports = { CodexAppServerBridge, CodexAppServerError, ALL_SOURCE_KINDS };
