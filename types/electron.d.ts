export {};

import type { CodexBridgeSnapshotResponse } from "@/lib/codex/types";
import type { ClaudeSnapshot } from "@/lib/providers/types";

type CodexStartInput = {
  cwd: string;
  title: string;
  objective: string;
  model?: string;
  reasoningEffort?: string;
  permission?: string;
};

type ClaudeStartInput = CodexStartInput & { sessionId?: string };
type AgentAttachment = { path: string; name: string; size: number; isImage: boolean };
type ContinueInput = { message: string; attachments: AgentAttachment[] };
type UpdateState = {
  phase: "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "error";
  currentVersion: string;
  latestVersion?: string;
  available?: boolean;
  releaseUrl?: string;
  releaseNotes?: string;
  publishedAt?: string;
  progress?: number;
  transferred?: number;
  total?: number;
  downloadedPath?: string;
  verified?: boolean;
  error?: string;
  isPackaged?: boolean;
};

declare global {
  interface Window {
    constellationDesktop?: {
      platform: string;
      isDesktop: boolean;
      appearance: {
        getScale: () => Promise<number>;
        setScale: (value: number) => Promise<number>;
      };
      selectDirectory: () => Promise<string | null>;
      projects: {
        list: () => Promise<string[]>;
        add: (projectPath: string) => Promise<string[]>;
      };
      updates: {
        getState: () => Promise<UpdateState>;
        check: () => Promise<UpdateState>;
        download: () => Promise<UpdateState>;
        install: () => Promise<UpdateState>;
        openRelease: () => Promise<boolean>;
        onStatus: (listener: (state: UpdateState) => void) => () => void;
      };
      files: {
        selectAttachments: (input: { cwd: string }) => Promise<AgentAttachment[]>;
        preview: (filePath: string) => Promise<{ dataUrl: string; width: number; height: number; name: string }>;
        reveal: (filePath: string) => Promise<boolean>;
      };
      codex: {
        getSnapshot: () => Promise<CodexBridgeSnapshotResponse>;
        readThread: (threadId: string) => Promise<unknown>;
        continueThread: (input: ContinueInput & { threadId: string }) => Promise<unknown>;
        startThread: (input: CodexStartInput) => Promise<unknown>;
        startSubagent: (input: Omit<CodexStartInput, "cwd"> & { parentThreadId: string }) => Promise<unknown>;
        updateThread: (input: Partial<CodexStartInput> & { threadId: string; cwd: string }) => Promise<unknown>;
        archiveThread: (threadId: string) => Promise<void>;
        unarchiveThread: (threadId: string) => Promise<void>;
        deleteThread: (threadId: string) => Promise<void>;
        onNotification: (listener: (message: { method: string; params?: Record<string, unknown> }) => void) => () => void;
        onConnection: (listener: (state: { status: "connected" | "offline"; error?: string }) => void) => () => void;
      };
      claude: {
        getSnapshot: () => Promise<Omit<ClaudeSnapshot, "provider"> & { connected: boolean; capabilities?: Record<string, boolean> }>;
        readSession: (sessionId: string) => Promise<unknown>;
        continueSession: (input: ContinueInput & { sessionId: string; cwd: string }) => Promise<{ started: boolean; sessionId: string | null }>;
        startSession: (input: ClaudeStartInput) => Promise<{ started: boolean; sessionId: string | null }>;
        startSubagent: (input: Omit<ClaudeStartInput, "cwd"> & { cwd: string; parentSessionId: string }) => Promise<{ started: boolean; sessionId: string | null }>;
        resumeSession: (input: ClaudeStartInput & { sessionId: string }) => Promise<{ started: boolean; sessionId: string | null }>;
        updateSession: (input: { sessionId: string; title?: string }) => Promise<unknown>;
        archiveSession: (sessionId: string) => Promise<void>;
        unarchiveSession: (sessionId: string) => Promise<void>;
        deleteSession: (sessionId: string) => Promise<void>;
        onNotification: (listener: (message: Record<string, unknown>) => void) => () => void;
        onConnection: (listener: (state: { status: "connected" | "offline"; error?: string }) => void) => () => void;
      };
    };
  }
}
