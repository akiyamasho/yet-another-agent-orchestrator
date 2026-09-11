import type { AgentProvider } from "@/lib/types";

/** A deliberately small, tolerant boundary for the Codex app-server response. */
export interface CodexRawThread {
  id: string;
  cwd?: string;
  workdir?: string;
  workingDirectory?: string;
  title?: string;
  name?: string;
  preview?: string;
  objective?: string;
  summary?: string;
  status?: unknown;
  source?: unknown;
  parentThreadId?: string | null;
  parent_thread_id?: string | null;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  reasoning_effort?: string;
  permission?: string;
  permissionMode?: string;
  branch?: string;
  createdAt?: string | number;
  created_at?: string | number;
  updatedAt?: string | number;
  updated_at?: string | number;
  startedAt?: string | number;
  finishedAt?: string | number;
  archived?: boolean;
  isArchived?: boolean;
  [key: string]: unknown;
}

/** Claude Code session records are intentionally permissive: JSONL/session formats evolve. */
export interface ClaudeRawSession {
  id?: string;
  sessionId?: string;
  session_id?: string;
  cwd?: string;
  projectPath?: string;
  project_path?: string;
  directory?: string;
  title?: string;
  name?: string;
  summary?: string;
  objective?: string;
  prompt?: string;
  status?: unknown;
  parentId?: string | null;
  parentSessionId?: string | null;
  parent_session_id?: string | null;
  model?: string;
  permission?: string;
  permissionMode?: string;
  branch?: string;
  createdAt?: string | number;
  created_at?: string | number;
  updatedAt?: string | number;
  updated_at?: string | number;
  startedAt?: string | number;
  finishedAt?: string | number;
  archived?: boolean;
  messages?: unknown[];
  [key: string]: unknown;
}

export interface ProviderEventRecord {
  id?: string;
  threadId?: string;
  thread_id?: string;
  parentEventId?: string;
  parent_event_id?: string;
  type?: string;
  title?: string;
  detail?: string;
  timestamp?: string | number;
  message?: string;
}

export interface CodexSnapshot {
  provider: "codex";
  threads: CodexRawThread[];
  projects?: string[];
  events?: ProviderEventRecord[];
}

export interface PiRawTicket {
  id: string;
  cwd: string;
  filePath: string;
  title?: string;
  objective?: string;
  summary?: string;
  status?: string;
  state?: string;
  priority?: string;
  labels?: string[];
  createdAt?: string;
  updatedAt?: string;
  acceptanceCriteria?: { text: string; completed: boolean; line?: number }[];
}

export interface PiSnapshot {
  provider: "pi";
  tickets: PiRawTicket[];
  projects?: string[];
}

export interface ClaudeSnapshot {
  provider: "claude";
  sessions: ClaudeRawSession[];
  projects?: string[];
  events?: ProviderEventRecord[];
}

export type ProviderSnapshot = CodexSnapshot | ClaudeSnapshot | PiSnapshot;

export interface ProviderMeta {
  provider: AgentProvider;
  label: string;
  shortLabel: string;
  color: string;
  icon: "codex" | "claude" | "pi";
}
