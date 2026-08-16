import type {
  AgentEvent,
  AgentThread,
  FolderContext,
  NormalizedState,
  PermissionMode,
  ThreadStatus,
} from "@/lib/types";
import type {
  CodexEventRecord,
  CodexSnapshot,
  CodexThreadListEnvelope,
  CodexThreadRecord,
} from "@/lib/codex/types";

const ACCENTS = ["#e2b84b", "#7aa7b8", "#c9875c", "#a78fbb", "#8fae8f", "#d4a86a"];
const STATUS_VALUES = new Set<ThreadStatus>(["running", "waiting", "needs_attention", "completed", "failed", "idle"]);

function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export function folderIdForCwd(cwd: string) {
  return `folder-${hash(cwd).toString(36)}`;
}

export function accentForCwd(cwd: string) {
  return ACCENTS[hash(cwd) % ACCENTS.length];
}

function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function dateText(value: unknown) {
  if (typeof value === "number") return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  if (typeof value === "string" && value) return value;
  return undefined;
}

function unwrapStatus(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return asText(record.type || record.status || record.state).toLowerCase();
  }
  return "";
}

function activeFlags(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const flags = (value as Record<string, unknown>).activeFlags;
  return Array.isArray(flags) ? flags.filter((item): item is string => typeof item === "string") : [];
}

export function mapThreadStatus(record: CodexThreadRecord): ThreadStatus {
  const status = unwrapStatus(record.status);
  if (record.archived || record.isArchived || status.includes("archiv")) return "completed";
  const flags = activeFlags(record.status);
  if (flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput")) return "needs_attention";
  if (status.includes("error") || status.includes("fail")) return "failed";
  if (status.includes("approval") || status.includes("attention") || status.includes("input")) return "needs_attention";
  if (status.includes("run") || status.includes("active") || status.includes("progress")) return "running";
  if (status.includes("wait") || status.includes("pause")) return "waiting";
  if (status.includes("complete") || status.includes("done") || status.includes("success")) return "completed";
  if (STATUS_VALUES.has(status as ThreadStatus)) return status as ThreadStatus;
  return "idle";
}

function permission(value: unknown): PermissionMode {
  const normalized = asText(value).toLowerCase();
  if (normalized.includes("full") || normalized.includes("danger")) return "full-access";
  if (normalized.includes("read")) return "read-only";
  return "workspace-write";
}

function sourceLabel(record: CodexThreadRecord) {
  const sourceRecord = record.source && typeof record.source === "object" ? record.source as Record<string, unknown> : undefined;
  const source = typeof record.source === "string" ? record.source : sourceRecord?.subAgent ? "subagent" : sourceRecord ? asText(sourceRecord.type || sourceRecord.kind || sourceRecord.custom) : "";
  return (record.kind || source || "agent").toLowerCase();
}

function isInternalGuardian(record: CodexThreadRecord) {
  if (!record.source || typeof record.source !== "object") return false;
  const subagent = (record.source as Record<string, unknown>).subAgent;
  return Boolean(subagent && typeof subagent === "object" && (subagent as Record<string, unknown>).other === "guardian");
}

function spawnedSubagentInfo(record: CodexThreadRecord) {
  if (!record.source || typeof record.source !== "object") return undefined;
  const subagent = (record.source as Record<string, unknown>).subAgent;
  if (!subagent || typeof subagent !== "object") return undefined;
  const spawn = (subagent as Record<string, unknown>).thread_spawn;
  return spawn && typeof spawn === "object" ? spawn as Record<string, unknown> : undefined;
}

function profileFor(record: CodexThreadRecord) {
  if (asText(record.agentRole)) return asText(record.agentRole);
  const spawnedRole = asText(spawnedSubagentInfo(record)?.agent_role);
  if (spawnedRole) return spawnedRole;
  const source = sourceLabel(record);
  if (source.includes("subagent") || source.includes("child")) return "subagent";
  if (source.includes("review")) return "reviewer";
  if (source.includes("explor") || source.includes("research")) return "researcher";
  return "agent";
}

export function extractThreads(input: CodexThreadListEnvelope | CodexThreadRecord[] | unknown): CodexThreadRecord[] {
  if (Array.isArray(input)) return input.filter((item): item is CodexThreadRecord => Boolean(item && typeof item === "object" && typeof (item as CodexThreadRecord).id === "string"));
  if (!input || typeof input !== "object") return [];
  const envelope = input as CodexThreadListEnvelope;
  if (Array.isArray(envelope.data)) return envelope.data;
  if (Array.isArray(envelope.threads)) return envelope.threads;
  if (Array.isArray(envelope.items)) return envelope.items;
  if (envelope.result) return extractThreads(envelope.result);
  return [];
}

function cwdFor(record: CodexThreadRecord) {
  return asText(record.cwd) || asText(record.workdir) || asText(record.workingDirectory) || "";
}

function titleFor(record: CodexThreadRecord) {
  const spawned = spawnedSubagentInfo(record);
  const spawnedPath = asText(spawned?.agent_path).split("/").filter(Boolean).at(-1) || "";
  return asText(record.title) || asText(record.name) || asText(record.agentNickname) || asText(spawned?.agent_nickname) || spawnedPath || asText(record.preview).slice(0, 96) || `Thread ${record.id.slice(0, 8)}`;
}

export function mapCodexSnapshot(snapshot: CodexSnapshot): NormalizedState {
  const records = extractThreads(snapshot.threads).filter((record) => !isInternalGuardian(record));
  const recordIds = new Set(records.map((record) => record.id));
  const folderByCwd = new Map<string, FolderContext>();
  const threads: Record<string, AgentThread> = {};

  (snapshot.projects || []).forEach((cwd) => {
    if (!cwd) return;
    const name = cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
    folderByCwd.set(cwd, { id: folderIdForCwd(cwd), name, path: cwd, accent: accentForCwd(cwd), defaultPermission: "workspace-write" });
  });

  records.forEach((record) => {
    const cwd = cwdFor(record);
    if (!cwd) return;
    const folderId = folderIdForCwd(cwd);
    if (!folderByCwd.has(cwd)) {
      const name = cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
      folderByCwd.set(cwd, { id: folderId, name, path: cwd, accent: accentForCwd(cwd), defaultPermission: permission(record.permissionMode || record.permission) });
    }
    const title = titleFor(record);
    const createdAt = dateText(record.createdAt ?? record.created_at ?? record.startedAt);
    const finishedAt = dateText(record.finishedAt ?? record.updatedAt ?? record.updated_at);
    const rawParentId = asText(record.parentThreadId) || asText(record.parent_thread_id) || asText(spawnedSubagentInfo(record)?.parent_thread_id) || undefined;
    const parentId = rawParentId && recordIds.has(rawParentId) ? rawParentId : undefined;
    const status = mapThreadStatus(record);
    threads[record.id] = {
      id: record.id,
      key: record.id.slice(0, 8).toUpperCase(),
      folderId,
      parentId,
      title,
      objective: asText(record.objective) || asText(record.preview).slice(0, 420) || title,
      summary: asText(record.summary) || asText(record.preview).slice(0, 220) || `${status.replace("_", " ")} · ${sourceLabel(record)}`,
      profile: profileFor(record),
      status,
      model: asText(record.model) || (asText(record.modelProvider) === "openai" ? "Codex" : asText(record.modelProvider)) || "Codex",
      reasoningEffort: asText(record.reasoningEffort) || asText(record.reasoning_effort) || "default",
      permission: permission(record.permissionMode || record.permission),
      branch: asText(record.branch) || asText(record.gitInfo?.branch) || undefined,
      startedAt: createdAt,
      finishedAt: finishedAt,
      archived: Boolean(record.archived || record.isArchived || unwrapStatus(record.status).includes("archiv")),
      attention: status === "needs_attention" ? { kind: unwrapStatus(record.status).includes("error") ? "error" : "input", message: "Codex is waiting for attention." } : undefined,
    };
  });

  const events: Record<string, AgentEvent> = {};
  (snapshot.events || []).forEach((record, index) => {
    const threadId = asText(record.threadId) || asText(record.thread_id);
    if (!threadId || !threads[threadId]) return;
    const timestamp = dateText(record.timestamp ?? record.createdAt) || new Date(0).toISOString();
    const eventId = asText(record.id) || `codex-event-${threadId}-${index}`;
    events[eventId] = { id: eventId, threadId, type: (record.type === "tool" || record.type === "file" || record.type === "approval" || record.type === "error" || record.type === "message" ? record.type : "status"), title: asText(record.title) || asText(record.type) || "Codex update", detail: asText(record.detail) || asText(record.message) || undefined, timestamp };
  });

  return { folders: Object.fromEntries(Array.from(folderByCwd.values()).map((folder) => [folder.id, folder])), threads, events };
}
