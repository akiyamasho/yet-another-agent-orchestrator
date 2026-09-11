import type { AgentEvent, AgentProvider, AgentThread, FolderContext, NormalizedState, PermissionMode, ThreadStatus } from "@/lib/types";
import type { ClaudeRawSession, ClaudeSnapshot, CodexRawThread, CodexSnapshot, PiRawRun, PiRawTicket, PiSnapshot, ProviderEventRecord, ProviderMeta, ProviderSnapshot } from "./types";

const COLORS = { codex: "#7aa7b8", claude: "#d97757", pi: "#c49a6c" } as const;
const FOLDER_COLORS = ["#e2b84b", "#7aa7b8", "#c9875c", "#a78fbb", "#8fae8f", "#d4a86a"] as const;
const EMPTY: NormalizedState = { folders: {}, threads: {}, events: {} };

export function providerMeta(provider: AgentProvider): ProviderMeta {
  if (provider === "codex") return { provider, label: "OpenAI Codex", shortLabel: "CODEX", color: COLORS.codex, icon: "codex" };
  if (provider === "claude") return { provider, label: "Claude Code", shortLabel: "CLAUDE", color: COLORS.claude, icon: "claude" };
  return { provider, label: "Pi orchestration", shortLabel: "PI", color: COLORS.pi, icon: "pi" };
}

function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function date(value: unknown) {
  if (typeof value === "number") return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  return typeof value === "string" && value ? value : undefined;
}
function validRecentTimestamp(value: string | undefined, maxAgeMs = 90_000) {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) <= maxAgeMs;
}
function hash(value: string) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) { result ^= value.charCodeAt(i); result = Math.imul(result, 16777619); }
  return (result >>> 0).toString(36);
}
function folderId(cwd: string) { return `folder-${hash(cwd)}`; }
function folderColor(cwd: string) { return FOLDER_COLORS[parseInt(hash(cwd), 36) % FOLDER_COLORS.length]; }
function piPhaseLabel(phase: unknown) {
  const value = text(phase).toLowerCase();
  return value === "planning" || value === "planner" ? "PLANNER" : value === "reviewer" ? "REVIEWER" : "WORKER";
}
export function providerThreadId(provider: AgentProvider, rawId: string) { return `${provider}:${rawId}`; }
export function splitProviderThreadId(id: string): { provider: AgentProvider; rawId: string } {
  const separator = id.indexOf(":");
  const provider = id.slice(0, separator) as AgentProvider;
  if (separator < 1 || !["codex", "claude", "pi"].includes(provider)) return { provider: "codex", rawId: id };
  return { provider, rawId: id.slice(separator + 1) };
}
function cwdOf(record: CodexRawThread | ClaudeRawSession | PiRawTicket) { return text(record.cwd) || text((record as ClaudeRawSession).projectPath) || text((record as ClaudeRawSession).project_path) || text((record as ClaudeRawSession).directory) || ""; }
function statusOf(value: unknown, archived = false): ThreadStatus {
  const status = typeof value === "string" ? value.toLowerCase().trim() : value && typeof value === "object" ? text((value as Record<string, unknown>).type || (value as Record<string, unknown>).status || (value as Record<string, unknown>).state).toLowerCase().trim() : "";
  if (status === "failed" || status.includes("error") || status.includes("fail")) return "failed";
  if (status === "done" || status === "completed" || status.includes("complete") || status.includes("success") || archived || status.includes("archiv")) return "completed";
  if (status === "review" || status === "manual_review" || status === "interrupted") return "waiting";
  if (status === "stale" || status === "blocked" || status.includes("attention") || status.includes("approval") || status.includes("input") || status.includes("block")) return "needs_attention";
  if (status === "reviewing" || status === "retrying" || status === "running" || status.includes("run") || status.includes("active") || status.includes("progress")) return "running";
  if (status.includes("wait") || status.includes("pause")) return "waiting";
  if (status === "todo" || status === "to-do" || status === "backlog" || status === "queued") return "idle";
  return (["idle", "waiting", "running", "needs_attention", "completed", "failed"] as ThreadStatus[]).includes(status as ThreadStatus) ? status as ThreadStatus : "idle";
}
function activeFlags(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const flags = (value as Record<string, unknown>).activeFlags;
  return Array.isArray(flags) ? flags.filter((item): item is string => typeof item === "string") : [];
}
function permission(value: unknown): PermissionMode {
  const normalized = text(value).toLowerCase();
  return normalized.includes("full") || normalized.includes("danger") ? "full-access" : normalized.includes("read") ? "read-only" : "workspace-write";
}
function codexSubagent(record: CodexRawThread) {
  const source = record.source && typeof record.source === "object" ? record.source as Record<string, unknown> : undefined;
  const subAgent = source?.subAgent;
  return subAgent && typeof subAgent === "object" ? subAgent as Record<string, unknown> : undefined;
}
function codexSpawn(record: CodexRawThread) {
  const spawn = codexSubagent(record)?.thread_spawn;
  return spawn && typeof spawn === "object" ? spawn as Record<string, unknown> : undefined;
}
function isGuardian(record: CodexRawThread) { return codexSubagent(record)?.other === "guardian"; }
function titleOf(provider: AgentProvider, record: CodexRawThread | ClaudeRawSession, id: string) {
  const value = text(record.title) || text(record.name);
  if (value) return value;
  if (provider === "codex") {
    const codex = record as CodexRawThread;
    const spawn = codexSpawn(codex);
    const agentName = text(spawn?.agent_nickname) || text(spawn?.agent_path).split("/").filter(Boolean).at(-1) || text(codex.preview).slice(0, 96);
    if (agentName) return agentName;
  }
  const claude = record as ClaudeRawSession;
  const firstMessage = Array.isArray(claude.messages) ? claude.messages.find((item) => item && typeof item === "object" && text((item as Record<string, unknown>).role) === "user") : undefined;
  const firstMessageText = firstMessage && typeof firstMessage === "object" ? text((firstMessage as Record<string, unknown>).content).slice(0, 96) : "";
  return text(record.objective) || text(record.prompt) || text(record.summary) || firstMessageText || `${provider === "codex" ? "Codex" : "Claude"} ${id.slice(0, 8)}`;
}
function rawId(provider: AgentProvider, record: CodexRawThread | ClaudeRawSession | PiRawTicket) { return provider === "codex" ? text((record as CodexRawThread).id) : provider === "pi" ? text((record as PiRawTicket).filePath) : text((record as ClaudeRawSession).id) || text((record as ClaudeRawSession).sessionId) || text((record as ClaudeRawSession).session_id); }
function parentRaw(provider: AgentProvider, record: CodexRawThread | ClaudeRawSession | PiRawTicket) { return provider === "codex" ? text((record as CodexRawThread).parentThreadId) || text((record as CodexRawThread).parent_thread_id) || text(codexSpawn(record as CodexRawThread)?.parent_thread_id) : text((record as ClaudeRawSession).parentId) || text((record as ClaudeRawSession).parentSessionId) || text((record as ClaudeRawSession).parent_session_id); }

function mapSnapshot(snapshot: ProviderSnapshot): NormalizedState {
  const provider = snapshot.provider;
  const records: any[] = provider === "codex" ? snapshot.threads.filter((record) => !isGuardian(record)) : provider === "claude" ? snapshot.sessions : snapshot.tickets;
  const state: NormalizedState = { folders: {}, threads: {}, events: {} };
  const rawIds = new Set(records.map((record) => rawId(provider, record)).filter(Boolean));
  const projectPaths = snapshot.projects || [];
  [...projectPaths, ...records.map(cwdOf)].filter(Boolean).forEach((cwd) => {
    if (state.folders[folderId(cwd)]) return;
    const name = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
    state.folders[folderId(cwd)] = { id: folderId(cwd), name, path: cwd, accent: folderColor(cwd), defaultPermission: "workspace-write" };
  });
  records.forEach((record) => {
    const id = rawId(provider, record); const cwd = cwdOf(record);
    if (!id || !cwd) return;
    const stateId = providerThreadId(provider, id);
    const flags = activeFlags(record.status);
    const status = flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput") ? "needs_attention" : statusOf(record.status, Boolean(record.archived));
    // `recencyAt` is the app-server's authoritative activity timestamp. The
    // list endpoint may omit `updatedAt` while still providing this value.
    const updatedAt = date(record.recencyAt ?? record.recency_at ?? record.updatedAt ?? record.updated_at);
    const rawStatus = typeof record.status === "string" ? record.status.toLowerCase() : record.status && typeof record.status === "object" ? text((record.status as Record<string, unknown>).type || (record.status as Record<string, unknown>).status || (record.status as Record<string, unknown>).state).toLowerCase() : "";
    const externalActivityHint = provider === "codex" ? /not[ _-]?loaded|unloaded/.test(rawStatus) : !rawStatus || /idle|unknown/.test(rawStatus);
    // The app-server can report a Codex thread as `notLoaded` while another
    // Codex client is actively working on it. Match the chat timeline's
    // conservative inference here so the global Now view does not depend on
    // opening the inspector first. Only the provider-specific external
    // runtime signal can promote an otherwise idle thread; explicit statuses
    // and attention flags always win, and the signal expires after 45 seconds.
    const inferredExternalRuntime = provider === "codex" && status === "idle" && externalActivityHint && validRecentTimestamp(updatedAt, 45_000);
    const normalizedStatus: ThreadStatus = inferredExternalRuntime ? "running" : status;
    const recentlyActiveExternally = normalizedStatus !== "running" && normalizedStatus !== "needs_attention" && externalActivityHint && validRecentTimestamp(updatedAt);
    const rawParent = parentRaw(provider, record);
    const parentId = rawParent && rawIds.has(rawParent) ? providerThreadId(provider, rawParent) : undefined;
    const title = titleOf(provider, record, id);
    const codex = record as CodexRawThread;
    const pi = record as PiRawTicket;
    state.threads[stateId] = { id: stateId, key: id.slice(0, 8).toUpperCase(), folderId: folderId(cwd), parentId, title, objective: text(record.objective) || text(record.prompt) || text(record.summary) || text(codex.preview).slice(0, 420) || title, summary: text(record.summary) || text(codex.preview).slice(0, 220) || `${normalizedStatus.replace("_", " ")} · ${providerMeta(provider).label}`, profile: provider === "codex" ? (text(codexSpawn(codex)?.agent_role) || "codex-agent") : provider === "pi" ? "markdown-ticket" : ((record as ClaudeRawSession).isSidechain ? "claude-subagent" : "claude-agent"), status: normalizedStatus, model: text(record.model) || providerMeta(provider).label, reasoningEffort: text(codex.reasoningEffort) || text(codex.reasoning_effort) || "default", permission: permission(record.permissionMode || record.permission), branch: text(record.branch) || text((codex.gitInfo as Record<string, unknown> | undefined)?.branch) || undefined, startedAt: date(record.startedAt ?? record.createdAt ?? record.created_at), updatedAt, finishedAt: date(record.finishedAt), archived: Boolean(record.archived), provider, acceptanceCriteria: provider === "pi" ? pi.acceptanceCriteria : undefined, recentlyActiveExternally, attention: normalizedStatus === "needs_attention" ? { kind: "input", message: `${providerMeta(provider).label} is waiting for attention.` } : undefined };
  });
  ((snapshot as { events?: ProviderEventRecord[] }).events || []).forEach((event, index) => {
    const rawThread = text(event.threadId) || text(event.thread_id); const id = rawThread ? providerThreadId(provider, rawThread) : "";
    if (!id || !state.threads[id]) return;
    const eventId = `${provider}:${text(event.id) || `event-${index}`}`;
    const eventType = text(event.type);
    state.events[eventId] = { id: eventId, threadId: id, parentEventId: text(event.parentEventId) || text(event.parent_event_id), type: eventType === "tool" || eventType === "file" || eventType === "approval" || eventType === "error" || eventType === "message" ? eventType : "status", title: text(event.title) || eventType || `${providerMeta(provider).label} update`, detail: text(event.detail) || text(event.message) || undefined, timestamp: date(event.timestamp) || new Date(0).toISOString() };
  });
  return state;
}

export function normalizeCodex(snapshot: Omit<CodexSnapshot, "provider"> | CodexSnapshot) { return mapSnapshot({ ...snapshot, provider: "codex" }); }
export function normalizeClaude(snapshot: Omit<ClaudeSnapshot, "provider"> | ClaudeSnapshot) { return mapSnapshot({ ...snapshot, provider: "claude" }); }
export function normalizePi(snapshot: Omit<PiSnapshot, "provider"> | PiSnapshot): NormalizedState {
  const input = { ...snapshot, provider: "pi" as const };
  const state: NormalizedState = { folders: {}, threads: {}, events: {} };
  const tickets = input.tickets || [];
  const ticketsByProjectId = new Map<string, PiRawTicket[]>();
  tickets.forEach((ticket) => {
    const key = `${ticket.cwd}\u0000${ticket.id.toLowerCase()}`;
    ticketsByProjectId.set(key, [...(ticketsByProjectId.get(key) || []), ticket]);
  });
  const addFolder = (cwd: string) => {
    if (!cwd || state.folders[folderId(cwd)]) return;
    state.folders[folderId(cwd)] = { id: folderId(cwd), name: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd, path: cwd, accent: folderColor(cwd), defaultPermission: "workspace-write" };
  };
  tickets.forEach((ticket) => {
    const cwd = text(ticket.cwd); const canonical = text(ticket.filePath); if (!cwd || !canonical) return;
    addFolder(cwd);
    const parent = text(ticket.parentId) || text(ticket.parent);
    const parentMatches = parent ? ticketsByProjectId.get(`${cwd}\u0000${parent.toLowerCase()}`) : undefined;
    const parentTicket = parentMatches?.length === 1 ? parentMatches[0] : undefined;
    const id = `pi:${canonical}`; const completed = ticket.progress?.completed ?? ticket.acceptanceCriteria?.filter((item) => item.completed).length ?? 0; const total = ticket.progress?.total ?? ticket.acceptanceCriteria?.length ?? 0;
    const status = ticket.issue || ticket.duplicateId ? "needs_attention" : statusOf(ticket.status || ticket.state);
    state.threads[id] = { id, key: text(ticket.id) || canonical.split(/[\\/]/).pop()?.replace(/\.md$/, "") || "TICKET", folderId: folderId(cwd), parentId: parentTicket ? `pi:${parentTicket.filePath}` : undefined, title: text(ticket.title) || text(ticket.id), objective: text(ticket.objective) || text(ticket.title), summary: text(ticket.summary) || ticket.issue || `${status.replace("_", " ")} · Pi ticket`, profile: "markdown-ticket", status, model: "Pi", reasoningEffort: "default", permission: "workspace-write", startedAt: date(ticket.createdAt), updatedAt: date(ticket.updatedAt), provider: "pi", piKind: "ticket", ticketState: text(ticket.state || ticket.status), projectRoot: cwd, progress: { completed, total }, acceptanceCriteria: ticket.acceptanceCriteria, assignee: text(ticket.assignee) || undefined, blockedBy: ticket.blockedBy, attention: status === "needs_attention" ? { kind: "input", message: ticket.issue || "This Pi ticket needs attention." } : undefined, issue: ticket.issue, duplicateId: ticket.duplicateId, missingBlocker: ticket.issue?.match(/Missing blocker ticket:\s*(.+)$/i)?.[1], ticketPath: canonical };
  });
  const ticketByProjectId = new Map(tickets.map((ticket) => [`${ticket.cwd}\u0000${ticket.id.toLowerCase()}`, `pi:${ticket.filePath}`]));
  const ticketByPath = new Map(tickets.map((ticket) => [ticket.filePath, `pi:${ticket.filePath}`]));
  (input.runs || []).forEach((run: PiRawRun) => {
    const linkedTicket = run.ticketPath ? ticketByPath.get(text(run.ticketPath)) : undefined;
    const root = text(run.projectRoot) || text(run.cwd) || (linkedTicket ? tickets.find((ticket) => `pi:${ticket.filePath}` === linkedTicket)?.cwd : "") || (run.ticketId ? tickets.filter((ticket) => ticket.id.toLowerCase() === run.ticketId!.toLowerCase()).at(0)?.cwd : ""); if (!root) return; addFolder(root);
    const sameProjectMatches = tickets.filter((ticket) => ticket.cwd === root && ticket.id.toLowerCase() === String(run.ticketId || "").toLowerCase());
    const parent = linkedTicket || (sameProjectMatches.length === 1 ? ticketByProjectId.get(`${root}\u0000${run.ticketId!.toLowerCase()}`) : undefined); const status = statusOf(run.status);
    const id = `pi:run:${run.runId}`;
    const phaseLabel = piPhaseLabel(run.phase);
    const integration = run.integration && typeof run.integration === "object" ? run.integration : {};
    const cleanup = integration.cleanup && typeof integration.cleanup === "object" ? integration.cleanup : {};
    const reviewResult = (run.reviewResult && typeof run.reviewResult === "object" ? run.reviewResult : (integration.reviewResult && typeof integration.reviewResult === "object" ? integration.reviewResult : {})) as Record<string, unknown>;
    const integrationPhase = text(run.integrationPhase) || text(integration.phase);
    const cleanupPhase = text(run.cleanupPhase) || text(cleanup.phase);
    const integrationError = text(run.integrationError) || text(integration.error);
    const cleanupError = text(run.cleanupError) || text(cleanup.error);
    const actionableError = cleanupError || integrationError || text(run.error) || undefined;
    state.threads[id] = { id, key: run.runId, folderId: folderId(root), parentId: parent, title: `${phaseLabel} · ${run.ticketId || "Objective"}`, objective: text(run.objective) || "Pi orchestration run", summary: text(run.summary) || actionableError || `${phaseLabel.toLowerCase()} run`, profile: `pi-${String(run.phase || "run")}`, status, model: text(run.model) || "Pi", reasoningEffort: "default", permission: "workspace-write", branch: text(run.branch) || undefined, startedAt: date(run.startedAt), updatedAt: date(run.finishedAt) || date(run.startedAt), finishedAt: date(run.finishedAt), provider: "pi", piKind: "run", runId: run.runId, runPhase: String(run.phase || "run"), projectRoot: root, workspace: text(run.workspace) || root, integrationPhase: integrationPhase || undefined, reviewResult: Object.keys(reviewResult).length ? { status: text(reviewResult.status), timestamp: text(reviewResult.timestamp), sourceHead: text(reviewResult.sourceHead) } : undefined, cleanupPhase: cleanupPhase || undefined, sourceHead: text(run.sourceHead) || text(integration.sourceHead) || undefined, mergeCommit: text(run.mergeCommit) || text(integration.mergeCommit) || undefined, completionCommit: text(run.completionCommit) || text(integration.completionCommit) || undefined, finalDestinationHead: text(run.finalDestinationHead) || text(integration.finalDestinationHead) || undefined, integrationError: integrationError || undefined, cleanupError: cleanupError || undefined, error: actionableError, attention: status === "needs_attention" || Boolean(actionableError) ? { kind: "error", message: actionableError || "Pi run needs attention." } : undefined };
  });
  (input.runEvents || []).forEach((event, index) => { const threadId = `pi:run:${text(event.runId)}`; if (!state.threads[threadId]) return; const type = text(event.event); state.events[`pi:run-event:${text(event.id) || `${event.runId}-${index}`}`] = { id: `pi:run-event:${text(event.id) || `${event.runId}-${index}`}`, threadId, type: type.includes("error") ? "error" : type.includes("output") ? "message" : "status", title: type || "Pi run update", detail: text(event.output) || text(event.summary) || text(event.error) || undefined, timestamp: date(event.timestamp) || new Date(0).toISOString() }; });
  return state;
}
export function mergeNormalizedStates(...states: NormalizedState[]): NormalizedState {
  return states.reduce((merged, state) => ({ folders: { ...merged.folders, ...state.folders }, threads: { ...merged.threads, ...state.threads }, events: { ...merged.events, ...state.events } }), { ...EMPTY });
}
export function normalizeProviders(input: { codex?: Omit<CodexSnapshot, "provider"> | CodexSnapshot; claude?: Omit<ClaudeSnapshot, "provider"> | ClaudeSnapshot; pi?: Omit<PiSnapshot, "provider"> | PiSnapshot }): NormalizedState {
  return mergeNormalizedStates(input.codex ? normalizeCodex(input.codex) : EMPTY, input.claude ? normalizeClaude(input.claude) : EMPTY, input.pi ? normalizePi(input.pi) : EMPTY);
}
export function filterByProvider(state: NormalizedState, provider?: AgentProvider): NormalizedState {
  if (!provider) return state;
  const threads = Object.fromEntries(Object.entries(state.threads).filter(([, thread]) => thread.provider === provider));
  const threadIds = new Set(Object.keys(threads));
  return { folders: Object.fromEntries(Object.entries(state.folders).filter(([, folder]) => Object.values(threads).some((thread) => thread.folderId === folder.id))), threads, events: Object.fromEntries(Object.entries(state.events).filter(([, event]) => threadIds.has(event.threadId))) };
}
export function providerCounts(state: NormalizedState) { return { codex: Object.values(state.threads).filter((thread) => thread.provider === "codex").length, claude: Object.values(state.threads).filter((thread) => thread.provider === "claude").length, pi: Object.values(state.threads).filter((thread) => thread.provider === "pi").length }; }

export type { ClaudeSnapshot, CodexSnapshot, PiSnapshot, ProviderEventRecord, ProviderMeta, ProviderSnapshot } from "./types";
