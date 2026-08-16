/**
 * Renderer-side contracts for the Electron Codex bridge.
 *
 * The app-server protocol is intentionally represented as a tolerant boundary:
 * protocol additions should not require changing the UI's normalized model.
 */
export interface CodexThreadRecord {
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
  kind?: string;
  parentThreadId?: string | null;
  parent_thread_id?: string | null;
  archived?: boolean;
  isArchived?: boolean;
  model?: string;
  modelProvider?: string;
  agentNickname?: string | null;
  agentRole?: string | null;
  gitInfo?: { branch?: string | null } | null;
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
  [key: string]: unknown;
}

export interface CodexThreadListEnvelope {
  data?: CodexThreadRecord[];
  threads?: CodexThreadRecord[];
  items?: CodexThreadRecord[];
  result?: CodexThreadRecord[] | { data?: CodexThreadRecord[]; threads?: CodexThreadRecord[]; items?: CodexThreadRecord[] };
  nextCursor?: string | null;
  next_cursor?: string | null;
}

export interface CodexEventRecord {
  id?: string;
  threadId?: string;
  thread_id?: string;
  type?: string;
  title?: string;
  detail?: string;
  message?: string;
  timestamp?: string | number;
  createdAt?: string | number;
  [key: string]: unknown;
}

export interface CodexSnapshot {
  threads: CodexThreadRecord[] | CodexThreadListEnvelope;
  events?: CodexEventRecord[];
  projects?: string[];
}

export interface CodexBridgeSnapshotResponse extends CodexSnapshot {
  connected: boolean;
  error?: string;
}
