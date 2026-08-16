const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { CodexAppServerBridge } = require("./codex/app-server-bridge.cjs");
const { ClaudeCodeProvider } = require("./claude/provider.cjs");
const { normalizeCodexTimeline, normalizeClaudeTimeline } = require("./chat/timeline.cjs");
const { cleanupClipboardImages, saveClipboardImage } = require("./attachments/clipboard-image.cjs");
const { GitHubReleaseUpdater } = require("./updater/github-release-updater.cjs");

const isMac = process.platform === "darwin";
let mainWindow = null;
let codexBridge = null;
let codexConnectPromise = null;
let claudeProvider = null;
let releaseUpdater = null;
const recentEvents = [];
const recentClaudeEvents = [];
const codexRuntimeStatuses = new Map();
const codexLiveItems = new Map();
const allowedProjectRoots = new Set();
const attachmentGrants = new Map();
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function findCodexBinary() {
  const candidates = [
    process.env.CODEX_BIN,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(app.getPath("home"), ".local", "bin", "codex"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "codex";
}

function findClaudeBinary() {
  const candidates = [
    process.env.CLAUDE_BIN,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(app.getPath("home"), ".local", "bin", "claude"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "claude";
}

function projectsFile() {
  return path.join(app.getPath("userData"), "projects.json");
}

function preferencesFile() {
  return path.join(app.getPath("userData"), "preferences.json");
}

function readPreferences() {
  try { const value = JSON.parse(fs.readFileSync(preferencesFile(), "utf8")); return value && typeof value === "object" ? value : {}; }
  catch { return {}; }
}

function writePreferences(patch) {
  const next = { ...readPreferences(), ...patch };
  fs.mkdirSync(path.dirname(preferencesFile()), { recursive: true });
  fs.writeFileSync(preferencesFile(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function readProjects() {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectsFile(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && path.isAbsolute(item)) : [];
  } catch {
    return [];
  }
}

function writeProjects(projects) {
  fs.mkdirSync(path.dirname(projectsFile()), { recursive: true });
  fs.writeFileSync(projectsFile(), `${JSON.stringify([...new Set(projects)].sort(), null, 2)}\n`, "utf8");
}

function claudeSessionStateFile() {
  return path.join(app.getPath("userData"), "claude-session-state.json");
}

function readClaudeSessionState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeSessionStateFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function updateClaudeSessionState(sessionId, patch) {
  const state = readClaudeSessionState();
  state[sessionId] = { ...(state[sessionId] || {}), ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(claudeSessionStateFile()), { recursive: true });
  fs.writeFileSync(claudeSessionStateFile(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state[sessionId];
}

function rememberProjectRoot(projectPath) {
  if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) return;
  try { allowedProjectRoots.add(fs.realpathSync(projectPath)); }
  catch { allowedProjectRoots.add(path.resolve(projectPath)); }
}

function allowedLocalPath(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return null;
  let resolved;
  try { resolved = fs.realpathSync(filePath); } catch { return null; }
  const grantExpiry = attachmentGrants.get(resolved);
  if (grantExpiry && grantExpiry > Date.now()) return resolved;
  if (grantExpiry) attachmentGrants.delete(resolved);
  for (const root of allowedProjectRoots) {
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) return resolved;
  }
  return null;
}

function isImagePath(filePath) {
  return /\.(avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp)$/i.test(filePath);
}

function grantAttachment(filePath) {
  const resolved = fs.realpathSync(filePath);
  const stats = fs.statSync(resolved);
  if (!stats.isFile()) throw new Error("Attachments must be files.");
  if (stats.size > MAX_ATTACHMENT_BYTES) throw new Error(`${path.basename(resolved)} exceeds the 25 MB attachment limit.`);
  attachmentGrants.set(resolved, Date.now() + 60 * 60 * 1000);
  return { path: resolved, name: path.basename(resolved), size: stats.size, isImage: isImagePath(resolved) };
}

function validatedAttachments(input) {
  const attachments = Array.isArray(input) ? input.slice(0, MAX_ATTACHMENTS) : [];
  return attachments.map((item) => {
    const resolved = allowedLocalPath(item?.path);
    if (!resolved) throw new Error("An attachment is outside the selected projects and was not chosen through Constellation.");
    const stats = fs.statSync(resolved);
    if (!stats.isFile() || stats.size > MAX_ATTACHMENT_BYTES) throw new Error("Attachments must be files under 25 MB.");
    return { path: resolved, name: path.basename(resolved), size: stats.size, isImage: isImagePath(resolved) };
  });
}

function promptWithFiles(message, attachments, provider) {
  const text = String(message || "").trim();
  if (!attachments.length) return text;
  const references = attachments.map((item) => provider === "claude" ? `- @${item.path}` : `- ${item.path}`);
  const heading = provider === "claude"
    ? "Attached local files (open each @-mentioned file before responding):"
    : "Attached local files (read these paths as part of this request):";
  return [text, `${heading}\n${references.join("\n")}`].filter(Boolean).join("\n\n");
}

function codexTurnInput(message, attachments) {
  const images = attachments.filter((item) => item.isImage);
  const files = attachments.filter((item) => !item.isImage);
  const text = promptWithFiles(message, files, "codex") || (images.length ? "Review the attached image files." : "");
  return [
    ...(text ? [{ type: "text", text, text_elements: [] }] : []),
    ...images.map((item) => ({ type: "localImage", path: item.path })),
  ];
}

function activeTurnId(threadResult) {
  const thread = threadResult?.thread || threadResult;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const active = [...turns].reverse().find((turn) => {
    const value = turn?.status || turn?.state || "";
    const status = value && typeof value === "object" ? value.type || value.status || value.state || "" : value;
    return /inprogress|in_progress|running|active|started/i.test(String(status));
  });
  return active?.id || thread?.status?.activeTurnId || thread?.status?.active_turn_id || null;
}

function sendToRenderer(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
}

function createReleaseUpdater() {
  const updater = new GitHubReleaseUpdater({ owner: "akiyamasho", repo: "yet-another-agent-orchestrator", currentVersion: app.getVersion(), arch: process.arch, userData: app.getPath("userData"), execPath: process.execPath });
  updater.on("status", (state) => sendToRenderer("updates:status", { ...state, isPackaged: app.isPackaged }));
  return updater;
}

function cleanupPreviousUpdate() {
  const marker = path.join(app.getPath("userData"), "pending-update-cleanup.json");
  try {
    const value = JSON.parse(fs.readFileSync(marker, "utf8"));
    const currentApp = path.resolve(process.execPath, "..", "..", "..");
    const backup = typeof value.backup === "string" ? path.resolve(value.backup) : "";
    if (value.target === currentApp && path.dirname(backup) === path.dirname(currentApp) && path.basename(backup).startsWith(".Constellation.app.previous-") && fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`Could not clean the previous Constellation update: ${error.message}`);
  }
}

function rememberNotification(message) {
  const params = message.params || {};
  const threadId = params.threadId || params.thread_id || params.thread?.id || params.turn?.threadId;
  if (threadId) {
    if (message.method === "thread/status/changed" && params.status) codexRuntimeStatuses.set(String(threadId), params.status);
    else if (message.method === "turn/started") codexRuntimeStatuses.set(String(threadId), { type: "active", activeFlags: [] });
    else if (message.method === "turn/completed") codexRuntimeStatuses.set(String(threadId), { type: params.turn?.status === "failed" ? "systemError" : "idle" });
    const live = codexLiveItems.get(String(threadId)) || new Map();
    const incoming = params.item;
    if ((message.method === "item/started" || message.method === "item/completed") && incoming?.id) live.set(String(incoming.id), { ...incoming, turnId: params.turnId || incoming.turnId });
    else if (params.itemId && message.method === "item/agentMessage/delta") {
      const previous = live.get(String(params.itemId)) || { id: params.itemId, type: "agentMessage", turnId: params.turnId, text: "" };
      live.set(String(params.itemId), { ...previous, text: `${previous.text || ""}${params.delta || ""}` });
    } else if (params.itemId && message.method === "item/commandExecution/outputDelta") {
      const previous = live.get(String(params.itemId)) || { id: params.itemId, type: "commandExecution", turnId: params.turnId, aggregatedOutput: "", status: "inProgress" };
      live.set(String(params.itemId), { ...previous, aggregatedOutput: `${previous.aggregatedOutput || ""}${params.delta || ""}` });
    } else if (params.itemId && message.method === "item/reasoning/summaryTextDelta") {
      const previous = live.get(String(params.itemId)) || { id: params.itemId, type: "reasoning", turnId: params.turnId, summary: [], status: "inProgress" };
      const summary = Array.isArray(previous.summary) ? [...previous.summary] : [];
      summary[Number(params.summaryIndex) || 0] = `${summary[Number(params.summaryIndex) || 0] || ""}${params.delta || ""}`;
      live.set(String(params.itemId), { ...previous, summary });
    }
    if (live.size) {
      while (live.size > 300) live.delete(live.keys().next().value);
      codexLiveItems.set(String(threadId), live);
    }
    recentEvents.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      threadId,
      type: message.method.includes("approval") ? "approval" : message.method.includes("error") ? "error" : "status",
      title: message.method,
      detail: typeof params.message === "string" ? params.message : undefined,
      timestamp: new Date().toISOString(),
    });
    recentEvents.splice(250);
  }
  sendToRenderer("codex:notification", message);
}

function createCodexBridge() {
  const environmentPath = ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].filter(Boolean).join(":");
  const bridge = new CodexAppServerBridge({
    command: findCodexBinary(),
    cwd: app.getPath("home"),
    env: { PATH: environmentPath },
    autoRestart: true,
    restartDelayMs: 800,
  });
  bridge.on("notification", rememberNotification);
  bridge.on("ready", (details) => sendToRenderer("codex:connection", { status: "connected", details }));
  bridge.on("exit", ({ error }) => sendToRenderer("codex:connection", { status: "offline", error: error.message }));
  bridge.on("error", (error) => sendToRenderer("codex:connection", { status: "offline", error: error.message }));
  bridge.on("protocolError", (error) => console.error(error.message));
  bridge.on("stderr", (message) => {
    if (!message.includes("could not create PATH aliases")) console.error(message.trim());
  });
  return bridge;
}

function createClaudeProvider() {
  const provider = new ClaudeCodeProvider({ command: findClaudeBinary(), home: app.getPath("home") });
  provider.on("event", (event) => {
    const sessionId = event.sessionId || event.session_id;
    if (sessionId) {
      recentClaudeEvents.unshift({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        threadId: sessionId,
        type: event.type === "error" ? "error" : "status",
        title: event.type ? `Claude ${event.type}` : "Claude update",
        detail: typeof event.text === "string" ? event.text.slice(0, 500) : undefined,
        timestamp: new Date().toISOString(),
      });
      recentClaudeEvents.splice(250);
    }
    sendToRenderer("claude:notification", event);
  });
  provider.on("exit", (event) => sendToRenderer("claude:connection", { status: event.code === 0 ? "connected" : "offline", error: event.code === 0 ? undefined : `Claude exited with code ${event.code}.` }));
  provider.on("error", (error) => sendToRenderer("claude:connection", { status: "offline", error: error.message }));
  return provider;
}

function ensureClaude() {
  if (!claudeProvider) claudeProvider = createClaudeProvider();
  return claudeProvider;
}

async function ensureCodex() {
  if (codexBridge?.connected && codexBridge._initialized) return codexBridge;
  if (codexConnectPromise) return codexConnectPromise;
  if (!codexBridge) codexBridge = createCodexBridge();
  codexConnectPromise = codexBridge.connect({
    clientInfo: { name: "constellation", title: "Constellation", version: app.getVersion() },
    capabilities: { experimentalApi: true, requestAttestation: false },
  }).then(() => codexBridge).finally(() => { codexConnectPromise = null; });
  return codexConnectPromise;
}

async function snapshot() {
  const bridge = await ensureCodex();
  const threads = await bridge.listThreads({
    archived: false,
    limit: 200,
    sortKey: "recency_at",
    sortDirection: "desc",
    // Fast inventory path: selected Chat views use thread/read for repaired,
    // full history while live status is overlaid from this process's events.
    useStateDbOnly: true,
    sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "unknown"],
  });
  threads.forEach((thread) => {
    rememberProjectRoot(thread.cwd);
    const runtime = codexRuntimeStatuses.get(String(thread.id));
    if (runtime) thread.status = runtime;
  });
  readProjects().forEach(rememberProjectRoot);
  return { connected: true, threads, events: recentEvents, projects: readProjects() };
}

async function claudeSnapshot() {
  const provider = ensureClaude();
  const sessionState = readClaudeSessionState();
  const sessions = (await provider.listSessions()).filter((session) => !sessionState[session.id]?.hidden && !sessionState[session.id]?.archived).map((session) => ({ ...session, ...(sessionState[session.id]?.title ? { title: sessionState[session.id].title } : {}) }));
  sessions.forEach((session) => rememberProjectRoot(session.cwd));
  const projects = [...new Set([...readProjects(), ...sessions.map((session) => session.cwd).filter(Boolean)])];
  projects.forEach(rememberProjectRoot);
  return { connected: fs.existsSync(findClaudeBinary()), sessions, events: recentClaudeEvents, projects, capabilities: { ...provider.capabilities, rename: true, archive: true, delete: true, historyDestructiveDelete: false } };
}

function claudeArgs(input = {}) {
  const extraArgs = [];
  if (input.reasoningEffort && input.reasoningEffort !== "default") extraArgs.push("--effort", input.reasoningEffort);
  if (input.permission === "read-only") extraArgs.push("--permission-mode", "plan");
  else if (input.permission === "full-access") extraArgs.push("--permission-mode", "bypassPermissions");
  else if (input.permission === "workspace-write") extraArgs.push("--permission-mode", "acceptEdits");
  return extraArgs;
}

function startClaude(input, resume = false) {
  const model = input.model && input.model !== "default" && input.model !== "Claude Code" ? input.model : undefined;
  const attachments = validatedAttachments(input.attachments);
  const extraArgs = claudeArgs(input);
  const additionalDirs = [...new Set(attachments.map((item) => path.dirname(item.path)).filter((directory) => directory !== input.cwd))];
  additionalDirs.forEach((directory) => extraArgs.push("--add-dir", directory));
  const prompt = promptWithFiles(input.objective, attachments, "claude");
  const options = { cwd: input.cwd, prompt, name: input.title?.trim(), model, extraArgs };
  const handle = resume ? ensureClaude().resumeSession(input.sessionId, prompt, options) : ensureClaude().startSession(options);
  return { started: true, sessionId: handle.sessionId || input.sessionId || null };
}

async function continueCodex(input) {
  const message = String(input?.message || "").trim();
  const attachments = validatedAttachments(input?.attachments);
  if (!message && !attachments.length) throw new Error("Write a message or attach at least one file.");
  const bridge = await ensureCodex();
  const resumed = await bridge.resumeThread(String(input.threadId));
  const items = codexTurnInput(message, attachments);
  const runningTurnId = activeTurnId(resumed) || activeTurnId(await bridge.readThread(String(input.threadId), { includeTurns: true }));
  if (runningTurnId) return { mode: "steer", ...(await bridge.steerTurn(String(input.threadId), runningTurnId, items)) };
  return { mode: "turn", ...(await bridge.startTurn(String(input.threadId), items)) };
}

function sandboxPolicy(permission, cwd) {
  if (permission === "read-only") return { type: "readOnly", networkAccess: false };
  if (permission === "full-access") return { type: "dangerFullAccess" };
  return { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

function optionalModel(value) {
  return value && value !== "default" && value !== "Codex" ? value : undefined;
}

function registerIpc() {
  ipcMain.handle("folders:select", async () => {
    const result = await dialog.showOpenDialog({ title: "Add a project folder", properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("projects:add", (_event, projectPath) => {
    if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) throw new Error("Project path must be absolute.");
    writeProjects([...readProjects(), path.normalize(projectPath)]);
    rememberProjectRoot(projectPath);
    return readProjects();
  });
  ipcMain.handle("projects:list", () => readProjects());
  ipcMain.handle("appearance:get-scale", () => Number(readPreferences().uiScale) || 1);
  ipcMain.handle("appearance:set-scale", (event, value) => {
    const scale = [1, 1.1, 1.2].includes(Number(value)) ? Number(value) : 1;
    event.sender.setZoomFactor(scale);
    writePreferences({ uiScale: scale });
    return scale;
  });
  ipcMain.handle("updates:get-state", () => ({ ...(releaseUpdater?.snapshot() || { phase: "idle", currentVersion: app.getVersion() }), isPackaged: app.isPackaged }));
  ipcMain.handle("updates:check", async () => ({ ...(await releaseUpdater.check()), isPackaged: app.isPackaged }));
  ipcMain.handle("updates:download", async () => ({ ...(await releaseUpdater.download()), isPackaged: app.isPackaged }));
  ipcMain.handle("updates:install", async () => {
    if (!app.isPackaged) throw new Error("Automatic installation is available only in a packaged build.");
    const state = await releaseUpdater.install();
    setTimeout(() => app.quit(), 180);
    return { ...state, isPackaged: app.isPackaged };
  });
  ipcMain.handle("updates:open-release", () => {
    const url = releaseUpdater?.snapshot()?.releaseUrl || "https://github.com/akiyamasho/yet-another-agent-orchestrator/releases/latest";
    void shell.openExternal(url);
    return true;
  });
  ipcMain.handle("files:select-attachments", async (_event, input = {}) => {
    const defaultPath = typeof input.cwd === "string" && path.isAbsolute(input.cwd) ? input.cwd : undefined;
    const result = await dialog.showOpenDialog({ title: "Attach files to this agent", defaultPath, properties: ["openFile", "multiSelections"] });
    if (result.canceled) return [];
    return result.filePaths.slice(0, MAX_ATTACHMENTS).map(grantAttachment);
  });
  ipcMain.handle("files:paste-image", () => grantAttachment(saveClipboardImage({ image: clipboard.readImage(), userData: app.getPath("userData"), maxBytes: MAX_ATTACHMENT_BYTES })));
  ipcMain.handle("codex:snapshot", () => snapshot());
  ipcMain.handle("codex:read-thread", async (_event, threadId) => {
    const raw = await (await ensureCodex()).readThread(String(threadId), { includeTurns: true });
    const live = [...(codexLiveItems.get(String(threadId))?.values() || [])];
    const sourceThread = raw?.thread || raw || {};
    const liveByTurn = new Map();
    live.forEach((item) => { const turnId = String(item.turnId || "live"); const turn = liveByTurn.get(turnId) || { id: turnId, status: "inProgress", items: [] }; turn.items.push(item); liveByTurn.set(turnId, turn); });
    const timeline = normalizeCodexTimeline({ thread: { ...sourceThread, turns: [...(sourceThread.turns || []), ...liveByTurn.values()] } });
    const runtime = codexRuntimeStatuses.get(String(threadId));
    if (runtime) {
      timeline.sourceStatus = runtime.type || runtime.status || timeline.sourceStatus;
      timeline.status = runtime.activeFlags?.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput") ? "needs_attention" : runtime.type === "active" ? "running" : runtime.type === "systemError" ? "failed" : timeline.status;
      timeline.externalRuntime = false;
    }
    return timeline;
  });
  ipcMain.handle("codex:continue-thread", (_event, input) => continueCodex(input));
  ipcMain.handle("codex:start-thread", async (_event, input) => {
    const bridge = await ensureCodex();
    const response = await bridge.startThread({
      cwd: input.cwd,
      sandbox: input.permission || "workspace-write",
      serviceName: "constellation",
      ...(optionalModel(input.model) ? { model: input.model } : {}),
    });
    const threadId = response.thread.id;
    if (input.title?.trim()) await bridge.setThreadName(threadId, input.title.trim());
    await bridge.startTurn(threadId, input.objective.trim(), {
      ...(optionalModel(input.model) ? { model: input.model } : {}),
      ...(input.reasoningEffort && input.reasoningEffort !== "default" ? { effort: input.reasoningEffort } : {}),
    });
    return { ...response, thread: { ...response.thread, name: input.title?.trim() || response.thread.name } };
  });
  ipcMain.handle("codex:start-subagent", async (_event, input) => {
    const bridge = await ensureCodex();
    await bridge.resumeThread(input.parentThreadId);
    const task = input.title?.trim() ? `${input.title.trim()}: ${input.objective.trim()}` : input.objective.trim();
    return bridge.startTurn(input.parentThreadId, `Delegate this bounded task to a subagent and track it to completion:\n\n${task}`, {
      ...(optionalModel(input.model) ? { model: input.model } : {}),
      ...(input.reasoningEffort && input.reasoningEffort !== "default" ? { effort: input.reasoningEffort } : {}),
    });
  });
  ipcMain.handle("codex:update-thread", async (_event, input) => {
    const bridge = await ensureCodex();
    if (input.title?.trim()) await bridge.setThreadName(input.threadId, input.title.trim());
    const settings = {
      ...(optionalModel(input.model) ? { model: input.model } : {}),
      ...(input.reasoningEffort && input.reasoningEffort !== "default" ? { effort: input.reasoningEffort } : {}),
      ...(input.permission && input.cwd ? { sandboxPolicy: sandboxPolicy(input.permission, input.cwd) } : {}),
    };
    if (Object.keys(settings).length) await bridge.updateThreadSettings(input.threadId, settings);
    return bridge.readThread(input.threadId, { includeTurns: false });
  });
  ipcMain.handle("codex:archive-thread", async (_event, threadId) => (await ensureCodex()).archiveThread(String(threadId)));
  ipcMain.handle("codex:unarchive-thread", async (_event, threadId) => (await ensureCodex()).unarchiveThread(String(threadId)));
  ipcMain.handle("codex:delete-thread", async (_event, threadId) => (await ensureCodex()).deleteThread(String(threadId)));
  ipcMain.handle("claude:snapshot", () => claudeSnapshot());
  ipcMain.handle("claude:read-session", async (_event, sessionId) => normalizeClaudeTimeline(await ensureClaude().readSession(String(sessionId))));
  ipcMain.handle("claude:continue-session", (_event, input) => startClaude({ ...input, objective: input.message }, true));
  ipcMain.handle("claude:start-session", (_event, input) => startClaude(input, false));
  ipcMain.handle("claude:start-subagent", (_event, input) => startClaude({ ...input, sessionId: input.parentSessionId, objective: `Delegate this bounded task to a Claude Code subagent and track it to completion:\n\n${input.title?.trim() ? `${input.title.trim()}: ` : ""}${input.objective.trim()}` }, true));
  ipcMain.handle("claude:resume-session", (_event, input) => startClaude(input, true));
  ipcMain.handle("claude:update-session", (_event, input) => updateClaudeSessionState(String(input.sessionId), { title: String(input.title || "").trim() || undefined }));
  ipcMain.handle("claude:archive-session", (_event, sessionId) => updateClaudeSessionState(String(sessionId), { archived: true }));
  ipcMain.handle("claude:unarchive-session", (_event, sessionId) => updateClaudeSessionState(String(sessionId), { archived: false }));
  ipcMain.handle("claude:delete-session", (_event, sessionId) => updateClaudeSessionState(String(sessionId), { hidden: true }));
  ipcMain.handle("files:preview", (_event, filePath) => {
    const resolved = allowedLocalPath(filePath);
    if (!resolved) throw new Error("That file is outside the selected agent projects.");
    const stats = fs.statSync(resolved);
    if (!stats.isFile() || stats.size > 25 * 1024 * 1024) throw new Error("Image previews are limited to local files under 25 MB.");
    if (!/\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(resolved)) throw new Error("This file type cannot be previewed as an image.");
    const image = nativeImage.createFromPath(resolved);
    if (image.isEmpty()) throw new Error("Electron could not decode this image.");
    const size = image.getSize();
    return { dataUrl: image.toDataURL(), width: size.width, height: size.height, name: path.basename(resolved) };
  });
  ipcMain.handle("files:reveal", (_event, filePath) => {
    const resolved = allowedLocalPath(filePath);
    if (!resolved) throw new Error("That file is outside the selected agent projects.");
    shell.showItemInFolder(resolved);
    return true;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#08090b",
    title: "Constellation",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.setZoomFactor(Number(readPreferences().uiScale) || 1);
    console.log(`Constellation renderer ready: ${mainWindow.webContents.getURL()}`);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => console.error(`Constellation renderer failed (${code}): ${description}`));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => { if (url !== mainWindow.webContents.getURL()) event.preventDefault(); });
  mainWindow.loadFile(path.join(__dirname, "..", "out", "index.html"));
}

app.whenReady().then(() => {
  releaseUpdater = createReleaseUpdater();
  try { cleanupClipboardImages({ userData: app.getPath("userData") }); }
  catch (error) { console.error(`Could not clean old clipboard images: ${error.message}`); }
  registerIpc();
  Menu.setApplicationMenu(null);
  createWindow();
  if (app.isPackaged) setTimeout(cleanupPreviousUpdate, 8000);
  void ensureCodex().catch((error) => sendToRenderer("codex:connection", { status: "offline", error: error.message }));
  void claudeSnapshot().then(() => sendToRenderer("claude:connection", { status: "connected" })).catch((error) => sendToRenderer("claude:connection", { status: "offline", error: error.message }));
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("before-quit", () => codexBridge?.close());
app.on("window-all-closed", () => { if (!isMac) app.quit(); });
