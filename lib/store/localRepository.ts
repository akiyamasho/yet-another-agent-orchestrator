import { mockState } from "@/lib/data/mockData";
import type { AgentEvent, AgentRepository, AgentThread, CreateFolderInput, CreateThreadInput, FolderContext } from "@/lib/types";

/** Replaceable async boundary for a future Codex App Server adapter. */
export function createLocalRepository(): AgentRepository {
  let folders = { ...mockState.folders };
  let threads = { ...mockState.threads };
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    async listFolders() { return Object.values(folders); },
    async createFolder(input: CreateFolderInput) { const folder: FolderContext = { id: `folder-${Date.now()}`, name: input.name, path: input.path, accent: input.accent ?? "#67e8f9", defaultPermission: input.defaultPermission ?? "workspace-write" }; folders[folder.id] = folder; return folder; },
    async listThreads(folderId?: string) { return Object.values(threads).filter((thread) => !folderId || thread.folderId === folderId); },
    async createThread(input: CreateThreadInput) { const thread: AgentThread = { id: `thread-${Date.now()}`, key: `NEW-${Date.now().toString().slice(-4)}`, folderId: input.folderId, parentId: input.parentId, title: input.title, objective: input.objective, summary: "Starting task.", profile: input.profile ?? "builder", status: "idle", model: input.model ?? "gpt-5", reasoningEffort: input.reasoningEffort ?? "medium", permission: input.permission ?? "workspace-write", branch: input.branch }; threads[thread.id] = thread; return thread; },
    async updateThread(id, patch) { threads[id] = { ...threads[id], ...patch }; return threads[id]; },
    async archiveThread(id) { threads[id] = { ...threads[id], archived: true }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
