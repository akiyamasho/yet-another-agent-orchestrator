import type { AgentEvent, AgentProvider, AgentThread, FolderContext, NormalizedState, PermissionMode, ThreadStatus } from "@/lib/types";
import type { ClaudeRawSession, ClaudeSnapshot, CodexRawThread, CodexSnapshot, ProviderEventRecord, ProviderMeta, ProviderSnapshot } from "./types";

const COLORS = { codex: "#7aa7b8", claude: "#d97757" } as const;
const FOLDER_COLORS = ["#e2b84b", "#7aa7b8", "#c9875c", "#a78fbb", "#8fae8f", "#d4a86a"] as const;
const EMPTY: NormalizedState = { folders: {}, threads: {}, events: {} };

export function providerMeta(provider: AgentProvider): ProviderMeta {
  return provider === "codex"
    ? { provider, label: "OpenAI Codex", shortLabel: "CODEX", color: COLORS.codex, icon: "codex" }
    : { provider, label: "Claude Code", shortLabel: "CLAUDE", color: COLORS.claude, icon: "claude" };
}

function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function date(value: unknown) {
  if (typeof value === "number") return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  return typeof value === "string" && value ? value : undefined;
}
function validRecentTimestamp(value: string | undefined) {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) <= 90_000;
}
function hash(value: string) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) { result ^= value.charCodeAt(i); result = Math.imul(result, 16777619); }
  return (result >>> 0).toString(36);
}
function folderId(cwd: string) { return `folder-${hash(cwd)}`; }
function folderColor(cwd: string) { return FOLDER_COLORS[parseInt(hash(cwd), 36) % FOLDER_COLORS.length]; }
export function providerThreadId(provider: AgentProvider, rawId: string) { return `${provider}:${rawId}`; }
export function splitProviderThreadId(id: string): { provider: AgentProvider; rawId: string } {
  const separator = id.indexOf(":");
  const provider = id.slice(0, separator) as AgentProvider;
  if (separator < 1 || (provider !== "codex" && provider !== "claude")) return { provider: "codex", rawId: id };
  return { provider, rawId: id.slice(separator + 1) };
}
function cwdOf(record: CodexRawThread | ClaudeRawSession) { return text(record.cwd) || text((record as ClaudeRawSession).projectPath) || text((record as ClaudeRawSession).project_path) || text((record as ClaudeRawSession).directory) || ""; }
function statusOf(value: unknown, archived = false): ThreadStatus {
  const status = typeof value === "string" ? value.toLowerCase() : value && typeof value === "object" ? text((value as Record<string, unknown>).type || (value as Record<string, unknown>).status || (value as Record<string, unknown>).state).toLowerCase() : "";
  if (archived || status.includes("archiv")) return "completed";
  if (status.includes("error") || status.includes("fail")) return "failed";
  if (status.includes("approval") || status.includes("input") || status.includes("attention")) return "needs_attention";
  if (status.includes("run") || status.includes("active") || status.includes("progress")) return "running";
  if (status.includes("wait") || status.includes("pause")) return "waiting";
  if (status.includes("complete") || status.includes("done") || status.includes("success")) return "completed";
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
function rawId(provider: AgentProvider, record: CodexRawThread | ClaudeRawSession) { return provider === "codex" ? text((record as CodexRawThread).id) : text((record as ClaudeRawSession).id) || text((record as ClaudeRawSession).sessionId) || text((record as ClaudeRawSession).session_id); }
function parentRaw(provider: AgentProvider, record: CodexRawThread | ClaudeRawSession) { return provider === "codex" ? text((record as CodexRawThread).parentThreadId) || text((record as CodexRawThread).parent_thread_id) || text(codexSpawn(record as CodexRawThread)?.parent_thread_id) : text((record as ClaudeRawSession).parentId) || text((record as ClaudeRawSession).parentSessionId) || text((record as ClaudeRawSession).parent_session_id); }

function mapSnapshot(snapshot: ProviderSnapshot): NormalizedState {
  const provider = snapshot.provider;
  const records = (provider === "codex" ? snapshot.threads.filter((record) => !isGuardian(record)) : snapshot.sessions);
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
    const updatedAt = date(record.updatedAt ?? record.updated_at);
    const rawStatus = typeof record.status === "string" ? record.status.toLowerCase() : record.status && typeof record.status === "object" ? text((record.status as Record<string, unknown>).type || (record.status as Record<string, unknown>).status || (record.status as Record<string, unknown>).state).toLowerCase() : "";
    const externalActivityHint = provider === "codex" ? /not[ _-]?loaded|unloaded/.test(rawStatus) : !rawStatus || /idle|unknown/.test(rawStatus);
    const recentlyActiveExternally = status !== "running" && status !== "needs_attention" && externalActivityHint && validRecentTimestamp(updatedAt);
    const rawParent = parentRaw(provider, record);
    const parentId = rawParent && rawIds.has(rawParent) ? providerThreadId(provider, rawParent) : undefined;
    const title = titleOf(provider, record, id);
    const codex = record as CodexRawThread;
    state.threads[stateId] = { id: stateId, key: id.slice(0, 8).toUpperCase(), folderId: folderId(cwd), parentId, title, objective: text(record.objective) || text(record.prompt) || text(record.summary) || text(codex.preview).slice(0, 420) || title, summary: text(record.summary) || text(codex.preview).slice(0, 220) || `${status.replace("_", " ")} · ${providerMeta(provider).label}`, profile: provider === "codex" ? (text(codexSpawn(codex)?.agent_role) || "codex-agent") : ((record as ClaudeRawSession).isSidechain ? "claude-subagent" : "claude-agent"), status, model: text(record.model) || providerMeta(provider).label, reasoningEffort: text(codex.reasoningEffort) || text(codex.reasoning_effort) || "default", permission: permission(record.permissionMode || record.permission), branch: text(record.branch) || text((codex.gitInfo as Record<string, unknown> | undefined)?.branch) || undefined, startedAt: date(record.startedAt ?? record.createdAt ?? record.created_at), updatedAt, finishedAt: date(record.finishedAt), archived: Boolean(record.archived), provider, recentlyActiveExternally, attention: status === "needs_attention" ? { kind: "input", message: `${providerMeta(provider).label} is waiting for attention.` } : undefined };
  });
  (snapshot.events || []).forEach((event, index) => {
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
export function mergeNormalizedStates(...states: NormalizedState[]): NormalizedState {
  return states.reduce((merged, state) => ({ folders: { ...merged.folders, ...state.folders }, threads: { ...merged.threads, ...state.threads }, events: { ...merged.events, ...state.events } }), { ...EMPTY });
}
export function normalizeProviders(input: { codex?: Omit<CodexSnapshot, "provider"> | CodexSnapshot; claude?: Omit<ClaudeSnapshot, "provider"> | ClaudeSnapshot }): NormalizedState {
  return mergeNormalizedStates(input.codex ? normalizeCodex(input.codex) : EMPTY, input.claude ? normalizeClaude(input.claude) : EMPTY);
}
export function filterByProvider(state: NormalizedState, provider?: AgentProvider): NormalizedState {
  if (!provider) return state;
  const threads = Object.fromEntries(Object.entries(state.threads).filter(([, thread]) => thread.provider === provider));
  const threadIds = new Set(Object.keys(threads));
  return { folders: Object.fromEntries(Object.entries(state.folders).filter(([, folder]) => Object.values(threads).some((thread) => thread.folderId === folder.id))), threads, events: Object.fromEntries(Object.entries(state.events).filter(([, event]) => threadIds.has(event.threadId))) };
}
export function providerCounts(state: NormalizedState) { return { codex: Object.values(state.threads).filter((thread) => thread.provider === "codex").length, claude: Object.values(state.threads).filter((thread) => thread.provider === "claude").length }; }

export type { ClaudeSnapshot, CodexSnapshot, ProviderEventRecord, ProviderMeta, ProviderSnapshot } from "./types";
