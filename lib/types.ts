export type ThreadStatus = "running" | "waiting" | "needs_attention" | "completed" | "failed" | "idle";
export type PermissionMode = "read-only" | "workspace-write" | "full-access";
export type EventType = "message" | "tool" | "file" | "approval" | "error" | "status";
export type ViewMode = "map" | "list" | "activity";
export type AttentionKind = "approval" | "input" | "error";
export type AgentProvider = "codex" | "claude";

export interface FolderContext { id: string; name: string; path: string; accent: string; defaultPermission: PermissionMode; }
export interface AgentThread {
  id: string; key: string; folderId: string; parentId?: string; title: string; objective: string; summary: string;
  profile: string; status: ThreadStatus; model: string; reasoningEffort: string; permission: PermissionMode;
  branch?: string; startedAt?: string; finishedAt?: string; archived?: boolean;
  /** The runtime that owns this task. Optional for backwards-compatible local/demo records. */
  provider?: AgentProvider;
  attention?: { kind: AttentionKind; message: string };
}
export interface AgentEvent { id: string; threadId: string; parentEventId?: string; type: EventType; title: string; detail?: string; timestamp: string; }
export interface NormalizedState { folders: Record<string, FolderContext>; threads: Record<string, AgentThread>; events: Record<string, AgentEvent>; }
export interface CreateFolderInput { name: string; path: string; accent?: string; defaultPermission?: PermissionMode; }
export interface CreateThreadInput { folderId: string; parentId?: string; provider?: AgentProvider; title: string; objective: string; profile?: string; model?: string; reasoningEffort?: string; permission?: PermissionMode; branch?: string; }
export interface AgentRepository {
  listFolders(): Promise<FolderContext[]>;
  createFolder(input: CreateFolderInput): Promise<FolderContext>;
  listThreads(folderId?: string): Promise<AgentThread[]>;
  createThread(input: CreateThreadInput): Promise<AgentThread>;
  updateThread(id: string, patch: Partial<AgentThread>): Promise<AgentThread>;
  archiveThread(id: string, strategy?: "tree" | "reparent"): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
