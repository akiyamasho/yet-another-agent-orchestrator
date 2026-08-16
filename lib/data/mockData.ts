import type { AgentEvent, AgentThread, FolderContext, NormalizedState } from "@/lib/types";

export const mockFolders: FolderContext[] = [
  { id: "folder-agent-orchestration", name: "agent-orchestration", path: "~/Desktop/dev/research/agent-orchestration", accent: "#67e8f9", defaultPermission: "workspace-write" },
  { id: "folder-studio-site", name: "studio-site", path: "~/Projects/studio-site", accent: "#a78bfa", defaultPermission: "workspace-write" },
  { id: "folder-mobile-lab", name: "mobile-lab", path: "~/Projects/mobile-lab", accent: "#fb7185", defaultPermission: "read-only" },
  { id: "folder-signal-research", name: "signal-research", path: "~/Desktop/research/signal", accent: "#fbbf24", defaultPermission: "read-only" },
];

const roots: AgentThread[] = [
  ["AO-17", "Landing redesign", "Design and implement the new landing experience", "running", "folder-agent-orchestration"],
  ["AO-18", "Repository audit", "Audit architecture and identify maintenance risks", "needs_attention", "folder-agent-orchestration"],
  ["ST-04", "Portfolio polish", "Prepare the studio portfolio for review", "waiting", "folder-studio-site"],
  ["ST-05", "Accessibility pass", "Verify keyboard and screen-reader behavior", "completed", "folder-studio-site"],
  ["ML-21", "Sync engine", "Prototype offline-first data synchronization", "running", "folder-mobile-lab"],
  ["ML-22", "Release checks", "Run release validation on supported devices", "failed", "folder-mobile-lab"],
  ["SR-09", "Literature review", "Summarize recent research signals", "completed", "folder-signal-research"],
  ["SR-10", "Evidence map", "Connect claims to primary sources", "idle", "folder-signal-research"],
].map(([key, title, objective, status, folderId], index) => { const provider = index === 2 || index === 4 || index === 6 ? "claude" : "codex"; const updatedAt = ["2026-08-16T12:04:00.000Z", "2026-08-16T11:42:00.000Z", "2026-08-16T11:18:00.000Z", "2026-08-16T10:55:00.000Z", "2026-08-16T12:01:00.000Z", "2026-08-16T09:47:00.000Z", "2026-08-15T18:32:00.000Z", "2026-08-15T16:10:00.000Z"][index]; return { id: `thread-${key.toLowerCase()}`, key, folderId, title, objective, summary: status === "running" ? "Working through the next bounded task." : `Latest ${status.replace("_", " ")} update is available.`, profile: index % 2 ? "reviewer" : "builder", status: status as AgentThread["status"], model: provider === "claude" ? "Claude Sonnet" : "gpt-5", reasoningEffort: index % 2 ? "medium" : "high", permission: "workspace-write", branch: `${provider}/${key.toLowerCase()}`, startedAt: "2026-08-16T08:00:00.000Z", updatedAt, provider, attention: status === "needs_attention" ? { kind: "approval", message: "Approval required to continue." } : undefined } satisfies AgentThread; });

export const mockThreads: AgentThread[] = [
  ...roots,
  { id: "thread-ao-17-research", key: "AO-17.1", folderId: roots[0].folderId, parentId: roots[0].id, title: "Research references", objective: "Collect visual references", summary: "Three references ready for review.", profile: "researcher", status: "completed", model: "gpt-5", reasoningEffort: "medium", permission: "read-only", provider: "codex", updatedAt: "2026-08-16T10:20:00.000Z" },
  { id: "thread-ao-17-build", key: "AO-17.2", folderId: roots[0].folderId, parentId: roots[0].id, title: "Build interface", objective: "Implement responsive shell", summary: "Building the shared shell.", profile: "builder", status: "running", model: "gpt-5", reasoningEffort: "high", permission: "workspace-write", provider: "codex", updatedAt: "2026-08-16T12:06:00.000Z" },
  { id: "thread-ao-17-build-tests", key: "AO-17.2.1", folderId: roots[0].folderId, parentId: "thread-ao-17-build", title: "Component tests", objective: "Cover shell interactions", summary: "Test plan drafted.", profile: "tester", status: "waiting", model: "gpt-5", reasoningEffort: "medium", permission: "read-only", provider: "codex", updatedAt: "2026-08-16T09:58:00.000Z" },
  { id: "thread-ml-21-storage", key: "ML-21.1", folderId: roots[4].folderId, parentId: roots[4].id, title: "Storage adapter", objective: "Define durable local storage", summary: "Adapter interface is stable.", profile: "builder", status: "completed", model: "Claude Sonnet", reasoningEffort: "medium", permission: "workspace-write", provider: "claude", updatedAt: "2026-08-16T10:48:00.000Z" },
  { id: "thread-st-04-copy", key: "ST-04.1", folderId: roots[2].folderId, parentId: roots[2].id, title: "Copy review", objective: "Review page messaging", summary: "Waiting on final copy.", profile: "editor", status: "waiting", model: "Claude Sonnet", reasoningEffort: "low", permission: "read-only", provider: "claude", updatedAt: "2026-08-15T20:14:00.000Z", recentlyActiveExternally: true },
];

export const mockEvents: AgentEvent[] = mockThreads.slice(0, 8).map((thread, index) => ({ id: `event-${index + 1}`, threadId: thread.id, type: thread.status === "needs_attention" ? "approval" : "status", title: thread.status === "needs_attention" ? "Approval requested" : `${thread.status} · ${thread.title}`, detail: thread.summary, timestamp: new Date(Date.now() - index * 1000 * 60 * 17).toISOString() }));

export const mockState: NormalizedState = {
  folders: Object.fromEntries(mockFolders.map((folder) => [folder.id, folder])),
  threads: Object.fromEntries(mockThreads.map((thread) => [thread.id, thread])),
  events: Object.fromEntries(mockEvents.map((event) => [event.id, event])),
};
