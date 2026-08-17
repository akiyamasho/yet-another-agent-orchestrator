"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { mockState } from "@/lib/data/mockData";
import { normalizeProviders, splitProviderThreadId } from "@/lib/providers";
import { extractThreads } from "@/lib/codex/mapper";
import type { AgentEvent, AgentProvider, AgentThread, CreateFolderInput, CreateThreadInput, FolderContext, NormalizedState, ThreadStatus, ViewMode } from "@/lib/types";

export type ConnectionStatus = "loading" | "connected" | "offline" | "demo";
export type ProviderConnections = Record<AgentProvider, ConnectionStatus>;

type Store = NormalizedState & {
  selectedFolderId?: string;
  selectedThreadId?: string;
  viewMode: ViewMode;
  query: string;
  statusFilter?: ThreadStatus;
  connectionStatus: ConnectionStatus;
  providerConnections: ProviderConnections;
  connectionError?: string;
  lastSyncedAt?: string;
  selectFolder: (id?: string) => void;
  selectThread: (id?: string) => void;
  setViewMode: (mode: ViewMode) => void;
  setQuery: (query: string) => void;
  setStatusFilter: (status?: ThreadStatus) => void;
  setConnection: (status: ConnectionStatus, error?: string) => void;
  setProviderConnection: (provider: AgentProvider, status: ConnectionStatus) => void;
  setThreadRuntimeStatus: (id: string, status: ThreadStatus) => void;
  syncFromSource: () => Promise<void>;
  createFolder: (input: CreateFolderInput) => Promise<FolderContext>;
  createThread: (input: CreateThreadInput) => Promise<AgentThread>;
  updateThread: (id: string, patch: Partial<AgentThread>) => Promise<AgentThread>;
  archiveThread: (id: string, strategy?: "tree" | "reparent") => Promise<void>;
  unarchiveThread: (id: string) => Promise<void>;
  deleteThread: (id: string) => Promise<void>;
  addEvent: (event: AgentEvent) => void;
  filteredThreads: () => AgentThread[];
};

const emptyState: NormalizedState = { folders: {}, threads: {}, events: {} };
const id = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let syncInFlight: Promise<void> | undefined;

function localArchive(state: Store, threadId: string, strategy: "tree" | "reparent") {
  const ids = new Set([threadId]);
  if (strategy === "tree") {
    let changed = true;
    while (changed) {
      changed = false;
      Object.values(state.threads).forEach((thread) => {
        if (thread.parentId && ids.has(thread.parentId) && !ids.has(thread.id)) { ids.add(thread.id); changed = true; }
      });
    }
  }
  const threads = { ...state.threads };
  ids.forEach((item) => { if (threads[item]) threads[item] = { ...threads[item], archived: true }; });
  return threads;
}

function descendantThreadIds(state: Store, threadId: string) {
  const ids = new Set<string>([threadId]);
  let changed = true;
  while (changed) {
    changed = false;
    Object.values(state.threads).forEach((thread) => {
      if (thread.parentId && ids.has(thread.parentId) && !ids.has(thread.id)) {
        ids.add(thread.id);
        changed = true;
      }
    });
  }
  return ids;
}

export const useConstellationStore = create<Store>()(persist((set, get) => ({
  ...emptyState,
  viewMode: "map",
  query: "",
  connectionStatus: "loading",
  providerConnections: { codex: "loading", claude: "loading" },
  selectFolder: (selectedFolderId) => set({ selectedFolderId, selectedThreadId: undefined }),
  selectThread: (selectedThreadId) => set({ selectedThreadId }),
  setViewMode: (viewMode) => set({ viewMode }),
  setQuery: (query) => set({ query }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setConnection: (connectionStatus, connectionError) => set({ connectionStatus, connectionError }),
  setProviderConnection: (provider, status) => set((state) => ({ providerConnections: { ...state.providerConnections, [provider]: status } })),
  setThreadRuntimeStatus: (threadId, status) => set((state) => !state.threads[threadId] || state.threads[threadId].status === status ? state : ({ threads: { ...state.threads, [threadId]: { ...state.threads[threadId], status } } })),
  syncFromSource: async () => {
    if (syncInFlight) return syncInFlight;
    syncInFlight = (async () => {
      const desktop = window.constellationDesktop;
      if (!desktop) {
        set({ ...mockState, connectionStatus: "demo", providerConnections: { codex: "demo", claude: "demo" }, connectionError: undefined, lastSyncedAt: new Date().toISOString() });
        return;
      }
      if (!Object.keys(get().threads).length) set({ connectionStatus: "loading", connectionError: undefined });
      const [codexResult, claudeResult] = await Promise.allSettled([desktop.codex.getSnapshot(), desktop.claude.getSnapshot()]);
      const providerConnections: ProviderConnections = { codex: codexResult.status === "fulfilled" && codexResult.value.connected !== false ? "connected" : "offline", claude: claudeResult.status === "fulfilled" && claudeResult.value.connected !== false ? "connected" : "offline" };
      try {
        if (codexResult.status === "rejected" && claudeResult.status === "rejected") throw new Error(`Codex: ${String(codexResult.reason)} · Claude: ${String(claudeResult.reason)}`);
        const codexSnapshot = codexResult.status === "fulfilled" ? { ...codexResult.value, threads: extractThreads(codexResult.value.threads) } : undefined;
        const normalized = normalizeProviders({ codex: codexSnapshot, claude: claudeResult.status === "fulfilled" ? claudeResult.value : undefined });
        set((state) => ({
          ...normalized,
          connectionStatus: "connected",
          providerConnections,
          connectionError: undefined,
          lastSyncedAt: new Date().toISOString(),
          selectedFolderId: state.selectedFolderId && normalized.folders[state.selectedFolderId] ? state.selectedFolderId : undefined,
          selectedThreadId: state.selectedThreadId && normalized.threads[state.selectedThreadId] ? state.selectedThreadId : undefined,
        }));
      } catch (error) {
        set({ connectionStatus: "offline", providerConnections, connectionError: error instanceof Error ? error.message : String(error) });
      }
    })().finally(() => { syncInFlight = undefined; });
    return syncInFlight;
  },
  createFolder: async (input) => {
    const desktop = window.constellationDesktop;
    if (desktop) {
      await desktop.projects.add(input.path);
      await get().syncFromSource();
      const folder = Object.values(get().folders).find((item) => item.path === input.path);
      if (!folder) throw new Error("The agent project folder could not be registered.");
      return folder;
    }
    const folder = { id: id("folder"), name: input.name, path: input.path, accent: input.accent ?? "#e2b84b", defaultPermission: input.defaultPermission ?? "workspace-write" } satisfies FolderContext;
    set((state) => ({ folders: { ...state.folders, [folder.id]: folder } }));
    return folder;
  },
  createThread: async (input) => {
    const folder = get().folders[input.folderId];
    if (!folder) throw new Error("Choose a project folder first.");
    const desktop = window.constellationDesktop;
    const provider = input.parentId ? get().threads[input.parentId]?.provider ?? input.provider ?? "codex" : input.provider ?? "codex";
    if (desktop) {
      if (provider === "claude") {
        if (input.parentId) {
          const parent = splitProviderThreadId(input.parentId);
          await desktop.claude.startSubagent({ cwd: folder.path, parentSessionId: parent.rawId, title: input.title, objective: input.objective, model: input.model, reasoningEffort: input.reasoningEffort, permission: input.permission });
          return get().threads[input.parentId];
        }
        const response = await desktop.claude.startSession({ cwd: folder.path, title: input.title, objective: input.objective, model: input.model, reasoningEffort: input.reasoningEffort, permission: input.permission });
        const thread = { id: response.sessionId ? `claude:${response.sessionId}` : id("claude:launch"), key: response.sessionId?.slice(0, 8).toUpperCase() ?? "LAUNCH", title: input.title, objective: input.objective, folderId: input.folderId, summary: "Claude Code session launched; waiting for its first live event.", profile: input.profile ?? "claude-agent", status: "running", model: input.model && input.model !== "default" ? input.model : "Claude Code", reasoningEffort: input.reasoningEffort ?? "medium", permission: input.permission ?? "workspace-write", branch: input.branch, provider: "claude" } satisfies AgentThread;
        set((state) => ({ threads: { ...state.threads, [thread.id]: thread } }));
        return thread;
      }
      const bridge = desktop.codex;
      if (input.parentId) {
        const parent = splitProviderThreadId(input.parentId);
        await bridge.startSubagent({ parentThreadId: parent.rawId, title: input.title, objective: input.objective, model: input.model, reasoningEffort: input.reasoningEffort, permission: input.permission });
        await get().syncFromSource();
        return get().threads[input.parentId];
      }
      const response = await bridge.startThread({ cwd: folder.path, title: input.title, objective: input.objective, model: input.model, reasoningEffort: input.reasoningEffort, permission: input.permission });
      const responseThread = response && typeof response === "object" && "thread" in response ? (response as { thread?: { id?: string } }).thread : undefined;
      await get().syncFromSource();
      const created = responseThread?.id ? get().threads[`codex:${responseThread.id}`] : undefined;
      if (!created) throw new Error("Codex created the task, but it was not returned in the refreshed thread list.");
      return created;
    }
    const thread = { id: id("thread"), key: `NEW-${Date.now().toString().slice(-4)}`, title: input.title, objective: input.objective, folderId: input.folderId, parentId: input.parentId, summary: "Starting task.", profile: input.profile ?? "builder", status: "idle", model: input.model ?? "Codex", reasoningEffort: input.reasoningEffort ?? "medium", permission: input.permission ?? "workspace-write", branch: input.branch, provider } satisfies AgentThread;
    set((state) => ({ threads: { ...state.threads, [thread.id]: thread } }));
    return thread;
  },
  updateThread: async (threadId, patch) => {
    const thread = get().threads[threadId];
    if (!thread) throw new Error("Thread not found.");
    const desktop = window.constellationDesktop;
    if (desktop) {
      const folder = get().folders[thread.folderId];
      const { provider, rawId } = splitProviderThreadId(threadId);
      if (provider === "claude") await desktop.claude.updateSession({ sessionId: rawId, title: patch.title });
      else await desktop.codex.updateThread({ threadId: rawId, cwd: folder.path, title: patch.title, model: patch.model, reasoningEffort: patch.reasoningEffort, permission: patch.permission });
      await get().syncFromSource();
      return get().threads[threadId];
    }
    const updated = { ...thread, ...patch };
    set((state) => ({ threads: { ...state.threads, [threadId]: updated } }));
    return updated;
  },
  archiveThread: async (threadId, strategy = "tree") => {
    const desktop = window.constellationDesktop;
    if (desktop) { const { provider, rawId } = splitProviderThreadId(threadId); if (provider === "claude") await desktop.claude.archiveSession(rawId); else await desktop.codex.archiveThread(rawId); await get().syncFromSource(); return; }
    set((state) => ({ threads: localArchive(state, threadId, strategy) }));
  },
  unarchiveThread: async (threadId) => {
    const desktop = window.constellationDesktop;
    if (desktop) { const { provider, rawId } = splitProviderThreadId(threadId); if (provider === "claude") await desktop.claude.unarchiveSession(rawId); else await desktop.codex.unarchiveThread(rawId); await get().syncFromSource(); return; }
    set((state) => ({ threads: { ...state.threads, [threadId]: { ...state.threads[threadId], archived: false } } }));
  },
  deleteThread: async (threadId) => {
    const desktop = window.constellationDesktop;
    if (desktop) {
      const thread = get().threads[threadId];
      if (!thread) return;
      const { provider, rawId } = splitProviderThreadId(threadId);
      if (provider === "claude") await desktop.claude.deleteSession(rawId);
      else await desktop.codex.deleteThread(rawId);
      await get().syncFromSource();
      return;
    }
    set((state) => {
      const ids = descendantThreadIds(state, threadId);
      const threads = { ...state.threads };
      const events = { ...state.events };
      ids.forEach((id) => delete threads[id]);
      Object.values(events).forEach((event) => { if (ids.has(event.threadId)) delete events[event.id]; });
      const selectedThreadId = state.selectedThreadId && ids.has(state.selectedThreadId) ? undefined : state.selectedThreadId;
      return { threads, events, selectedThreadId };
    });
  },
  addEvent: (event) => set((state) => ({ events: { ...state.events, [event.id]: event } })),
  filteredThreads: () => {
    const { threads, query, selectedFolderId, statusFilter } = get();
    const needle = query.trim().toLowerCase();
    return Object.values(threads).filter((thread) => !thread.archived && (!selectedFolderId || thread.folderId === selectedFolderId) && (!statusFilter || thread.status === statusFilter) && (!needle || `${thread.key} ${thread.title} ${thread.objective} ${thread.summary}`.toLowerCase().includes(needle)));
  },
}), {
  name: "constellation-store",
  version: 2,
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({ selectedFolderId: state.selectedFolderId, selectedThreadId: state.selectedThreadId, viewMode: state.viewMode, query: state.query, statusFilter: state.statusFilter }),
  merge: (persisted, current) => {
    const preferences = persisted as Partial<Store>;
    return { ...current, selectedFolderId: preferences.selectedFolderId, selectedThreadId: preferences.selectedThreadId, viewMode: preferences.viewMode ?? current.viewMode, query: preferences.query ?? current.query, statusFilter: preferences.statusFilter };
  },
}));
