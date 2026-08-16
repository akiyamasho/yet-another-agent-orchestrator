"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bell, ChevronLeft, ChevronRight, Command, Folder, LayoutList, Map, Plus, Radio, RefreshCw, Settings, Sparkles } from "lucide-react";
import { MapView } from "@/components/map/MapView";
import { ListView } from "@/components/views/ListView";
import { ActivityView } from "@/components/views/ActivityView";
import { NowView } from "@/components/views/NowView";
import { InspectorPanel } from "@/components/inspector/InspectorPanel";
import { AgentDialogs, type AgentDialogMode } from "@/components/dialogs/AgentDialogs";
import { CommandPalette } from "@/components/command/CommandPalette";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { useConstellationStore } from "@/lib/store/useConstellationStore";
import styles from "./AppShell.module.css";
import type { AgentProvider } from "@/lib/types";
import type { ConnectionStatus } from "@/lib/store/useConstellationStore";

const views = [{ id: "now", label: "Now", icon: Radio }, { id: "map", label: "Map", icon: Map }, { id: "list", label: "List", icon: LayoutList }, { id: "activity", label: "Activity", icon: Activity }] as const;

export function AppShell() {
  const [railOpen, setRailOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const nowFolderScope = useRef<string | undefined>(undefined);
  const [dialog, setDialog] = useState<{ mode: AgentDialogMode; folderId?: string; threadId?: string }>();
  const folders = useConstellationStore((s) => s.folders); const threads = useConstellationStore((s) => s.threads);
  const viewMode = useConstellationStore((s) => s.viewMode); const selectedFolderId = useConstellationStore((s) => s.selectedFolderId); const selectedThreadId = useConstellationStore((s) => s.selectedThreadId);
  const selectFolder = useConstellationStore((s) => s.selectFolder); const selectThread = useConstellationStore((s) => s.selectThread); const setViewMode = useConstellationStore((s) => s.setViewMode); const setQuery = useConstellationStore((s) => s.setQuery);
  const connectionStatus = useConstellationStore((s) => s.connectionStatus); const connectionError = useConstellationStore((s) => s.connectionError); const syncFromSource = useConstellationStore((s) => s.syncFromSource); const setConnection = useConstellationStore((s) => s.setConnection); const setProviderConnection = useConstellationStore((s) => s.setProviderConnection);
  const providerConnections = useConstellationStore((s) => s.providerConnections);
  const folderList = useMemo(() => Object.values(folders), [folders]); const activeThreads = useMemo(() => Object.values(threads).filter((thread) => !thread.archived), [threads]);
  const attentionThreads = activeThreads.filter((thread) => thread.status === "needs_attention" || thread.attention); const selectedFolder = selectedFolderId ? folders[selectedFolderId] : undefined; const selectedThread = selectedThreadId ? threads[selectedThreadId] : undefined;
  const contextLabel = selectedFolder?.name ?? "All folders"; const closeDialog = () => setDialog(undefined); const openAgent = (folderId = selectedFolderId ?? folderList[0]?.id) => folderId ? setDialog({ mode: "agent", folderId }) : setDialog({ mode: "folder" });
  const locateThread = (id: string, fromNow = false) => { const target = threads[id]; if (fromNow) nowFolderScope.current = selectedFolderId; if (target) selectFolder(target.folderId); selectThread(id); setViewMode("map"); };
  const backToNow = () => { const threadToRestore = selectedThreadId; selectFolder(nowFolderScope.current); if (threadToRestore && threads[threadToRestore]) selectThread(threadToRestore); setViewMode("now"); };
  useEffect(() => {
    void syncFromSource();
    const desktop = window.constellationDesktop;
    if (!desktop) {
      const params = new URLSearchParams(window.location.search);
      const demoView = params.get("demoView");
      if (demoView === "now" || demoView === "map" || demoView === "list" || demoView === "activity") setViewMode(demoView);
      const demoFolder = params.get("demoFolder");
      if (demoFolder) window.setTimeout(() => selectFolder(demoFolder), 60);
      const demoThread = params.get("demoThread");
      if (demoThread) window.setTimeout(() => selectThread(demoThread), 80);
      if (params.get("demoJump") === "1") window.setTimeout(() => setPaletteOpen(true), 100);
      if (params.get("demoSettings") === "1") window.setTimeout(() => setSettingsOpen(true), 100);
      return;
    }
    let timer: number | undefined;
    const refreshSoon = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void syncFromSource(), 280); };
    const removeNotification = desktop.codex.onNotification(refreshSoon);
    const removeClaudeNotification = desktop.claude.onNotification(refreshSoon);
    const removeConnection = desktop.codex.onConnection((state) => { setProviderConnection("codex", state.status); if (state.status === "offline" && providerConnections.claude === "offline") setConnection("offline", state.error); else refreshSoon(); });
    const removeClaudeConnection = desktop.claude.onConnection((state) => { setProviderConnection("claude", state.status); if (state.status === "offline" && providerConnections.codex === "offline") setConnection("offline", state.error); else refreshSoon(); });
    const poll = window.setInterval(() => void syncFromSource(), 30_000);
    return () => { window.clearTimeout(timer); window.clearInterval(poll); removeNotification(); removeClaudeNotification(); removeConnection(); removeClaudeConnection(); };
  }, [providerConnections.claude, providerConnections.codex, selectThread, setConnection, setProviderConnection, setViewMode, syncFromSource]);
  const normalView = viewMode === "now" ? <NowView onOpen={(id) => { selectThread(id); setViewMode("now"); }} onLocate={(id) => locateThread(id, true)} /> : viewMode === "list" ? <ListView onNewAgent={() => openAgent()} /> : viewMode === "activity" ? <ActivityView onLocate={locateThread} /> : <MapView />;
  const view = connectionStatus === "loading" && !folderList.length ? <EmptyState title="Reading agent history" detail="Discovering your local Codex and Claude Code projects, chats, and agent trees…" spinning /> : connectionStatus === "offline" && !folderList.length ? <EmptyState title="Agent runtimes are not connected" detail={connectionError ?? "Constellation could not read Codex or Claude Code."} onRetry={() => void syncFromSource()} /> : !folderList.length ? <EmptyState title="No local projects yet" detail="Add a folder, then start a real Codex or Claude Code task in that project." onAdd={() => setDialog({ mode: "folder" })} /> : normalView;
  return <main className={`${styles.shell} ${railOpen ? styles.railExpanded : styles.railCollapsed}`} aria-label="Constellation workspace">
    <aside className={styles.rail} aria-label="Folder navigation">
      <div className={styles.brand}><span className={styles.brandMark}><Sparkles size={16} /></span>{railOpen && <span><strong>Constellation</strong><small>Agent operations</small></span>}</div>
      <nav className={styles.folderNav} aria-label="Folder contexts">
        <button className={`${styles.folderItem} ${!selectedFolderId ? styles.folderActive : ""}`} onClick={() => selectFolder(undefined)} aria-current={!selectedFolderId ? "page" : undefined}><span className={styles.folderIcon}><Sparkles size={16} /></span>{railOpen && <span className={styles.folderText}><strong>All folders</strong><small>{activeThreads.length} active threads</small></span>}</button>
        {folderList.map((folder) => { const folderThreads = activeThreads.filter((thread) => thread.folderId === folder.id); const count = folderThreads.length; const codexCount = folderThreads.filter((thread) => (thread.provider ?? "codex") === "codex").length; const claudeCount = folderThreads.filter((thread) => thread.provider === "claude").length; const needs = folderThreads.filter((thread) => (thread.attention || thread.status === "needs_attention")).length; return <button key={folder.id} className={`${styles.folderItem} ${selectedFolderId === folder.id ? styles.folderActive : ""}`} style={{ "--accent": folder.accent } as React.CSSProperties} onClick={() => selectFolder(folder.id)} aria-current={selectedFolderId === folder.id ? "page" : undefined} aria-label={`${folder.name}, ${count} active threads`}><span className={styles.folderIcon}><Folder size={16} /></span>{railOpen && <span className={styles.folderText}><strong>{folder.name}</strong><small>{folder.path}</small></span>}{railOpen && <span className={styles.counts}><b className={styles.codexCount}>C {codexCount}</b><b className={styles.claudeCount}>A {claudeCount}</b>{needs > 0 && <i>{needs}</i>}</span>}</button>; })}
      </nav>
      <button className={styles.addFolder} onClick={() => setDialog({ mode: "folder" })}><Plus size={16} />{railOpen && "Add folder"}</button>
      <div className={styles.railBottom}><button className={styles.utility} aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings size={16} />{railOpen && "Settings"}</button><button className={styles.collapse} onClick={() => setRailOpen((open) => !open)} aria-label={railOpen ? "Collapse folder rail" : "Expand folder rail"}>{railOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}</button></div>
    </aside>
    <section className={styles.workspace}>
      <header className={styles.commandBar}><div className={styles.breadcrumb}><span className={styles.crumbMuted}>Workspace</span><ChevronRight size={13} /><span className={styles.crumbAccent} style={{ color: selectedFolder?.accent }}>{contextLabel}</span>{selectedThread && <><ChevronRight size={13} /><span>{selectedThread.title}</span></>}</div>
        <div className={styles.toolbar}><ProviderBadge provider="codex" status={providerConnections.codex} error={connectionError} count={activeThreads.filter((thread) => (thread.provider ?? "codex") === "codex").length} /><ProviderBadge provider="claude" status={providerConnections.claude} count={activeThreads.filter((thread) => thread.provider === "claude").length} /><div className={styles.segmented} role="tablist" aria-label="Workspace view">{views.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setViewMode(id)} className={viewMode === id ? styles.segmentActive : ""} role="tab" aria-selected={viewMode === id}><Icon size={14} />{label}</button>)}</div><button className={styles.searchTrigger} onClick={() => setPaletteOpen(true)} title="Jump to any project or task"><Command size={14} /><span>Jump</span><kbd>⌘⇧O</kbd></button><button className={styles.newAgent} onClick={() => openAgent()}><Plus size={15} />New agent</button><button className={styles.attentionButton} onClick={() => { const first = attentionThreads[0]; if (first) selectThread(first.id); }} aria-label={`${attentionThreads.length} items need attention`}><Bell size={17} />{attentionThreads.length > 0 && <span>{attentionThreads.length}</span>}</button></div></header>
      <div className={styles.content}>{view}</div>
      {selectedThreadId && <InspectorPanel threadId={selectedThreadId} isMapView={viewMode === "map"} onBackToNow={backToNow} onClose={() => selectThread(undefined)} onAddSubagent={(id) => setDialog({ mode: "subagent", threadId: id })} onEdit={(id) => setDialog({ mode: "edit", threadId: id })} onArchive={(id) => setDialog({ mode: "archive", threadId: id })} onDelete={(id) => setDialog({ mode: "delete", threadId: id })} />}
    </section>
    <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onNewAgent={() => openAgent()} onAddFolder={() => setDialog({ mode: "folder" })} onShowAttention={() => { const first = attentionThreads[0]; if (first) selectThread(first.id); }} onFitOverview={() => { selectFolder(undefined); selectThread(undefined); setViewMode("map"); setQuery(""); }} />
    <AgentDialogs mode={dialog?.mode} folderId={dialog?.folderId} threadId={dialog?.threadId} onClose={closeDialog} onSaved={(id) => { if (dialog?.mode === "folder") selectFolder(id); else selectThread(id); }} />
    <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
  </main>;
}

function ProviderBadge({ provider, status, error, count }: { provider: AgentProvider; status: ConnectionStatus; error?: string; count: number }) {
  const label = provider === "codex" ? "CODEX" : "CLAUDE";
  const state = status === "connected" ? "LIVE" : status === "loading" ? "SYNC" : status === "demo" ? "DEMO" : "OFFLINE";
  return <span className={`${styles.connection} ${styles[status]} ${styles[`connection_${provider}`]}`} title={error ?? `${label} ${state}`}><span>{label}</span><small>{state} · {count}</small></span>;
}

export default AppShell;

function EmptyState({ title, detail, spinning, onRetry, onAdd }: { title: string; detail: string; spinning?: boolean; onRetry?: () => void; onAdd?: () => void }) {
  return <section className={styles.emptyState}><span className={spinning ? styles.spin : ""}><RefreshCw size={22} /></span><p>LOCAL AGENTS</p><h1>{title}</h1><small>{detail}</small>{onRetry && <button onClick={onRetry}>Try again</button>}{onAdd && <button onClick={onAdd}><Plus size={14}/>Add project folder</button>}</section>;
}
