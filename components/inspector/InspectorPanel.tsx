"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CircleAlert, Clock3, Pause, Play, RotateCcw, Square, X } from "lucide-react";
import { AgentChatTimeline, type ChatTimeline } from "@/components/chat/AgentChatTimeline";
import { ThreadComposer } from "@/components/inspector/ThreadComposer";
import { providerMeta, splitProviderThreadId } from "@/lib/providers";
import { useConstellationStore } from "@/lib/store/useConstellationStore";
import type { ThreadStatus } from "@/lib/types";
import { classifyLiveness, formatLivenessNotice } from "@/lib/runtime/liveness";
import styles from "./InspectorPanel.module.css";

type InspectorTab = "overview" | "subagents" | "activity" | "chat";
const statusLabel: Record<ThreadStatus, string> = { running: "Running", waiting: "Waiting", needs_attention: "Needs attention", completed: "Completed", failed: "Failed", idle: "Idle" };
const formatTime = (iso?: string) => iso ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "—";

export interface InspectorPanelProps { threadId?: string; isMapView?: boolean; onBackToNow?: () => void; onClose?: () => void; onAddSubagent?: (threadId: string) => void; onEdit?: (threadId: string) => void; onArchive?: (threadId: string) => void; onDelete?: (threadId: string) => void; }

export function InspectorPanel({ threadId, isMapView, onBackToNow, onClose, onAddSubagent, onEdit, onArchive, onDelete }: InspectorPanelProps) {
  const [tab, setTab] = useState<InspectorTab>("chat");
  const [attentionDone, setAttentionDone] = useState(false);
  const [detail, setDetail] = useState<unknown>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [focusedPreview, setFocusedPreview] = useState<{ path: string; dataUrl: string; name: string }>();
  const previewRequests = useRef(new Set<string>());
  const activeRequest = useRef<symbol | undefined>(undefined);
  const detailRevision = useRef("");
  const lastNotificationRefresh = useRef(0);
  const notificationTimer = useRef<number | undefined>(undefined);
  const notificationPending = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const chatOutputRef = useRef<HTMLElement>(null);
  const scrollFrame = useRef<number | undefined>(undefined);
  const pinnedToBottom = useRef(true);
  const [cancelRequest, setCancelRequest] = useState(0);
  const selectedThreadId = useConstellationStore((s) => threadId ?? s.selectedThreadId);
  const thread = useConstellationStore((s) => selectedThreadId ? s.threads[selectedThreadId] : undefined);
  const folder = useConstellationStore((s) => thread ? s.folders[thread.folderId] : undefined);
  const threads = useConstellationStore((s) => s.threads);
  const events = useConstellationStore((s) => s.events);
  const updateThread = useConstellationStore((s) => s.updateThread);
  const connectionStatus = useConstellationStore((s) => s.connectionStatus);
  const selectThread = useConstellationStore((s) => s.selectThread);
  const syncFromSource = useConstellationStore((s) => s.syncFromSource);
  const setThreadRuntimeStatus = useConstellationStore((s) => s.setThreadRuntimeStatus);
  const threadProvider = thread?.provider ?? "codex";
  const children = useMemo(() => thread ? Object.values(threads).filter((item) => item.parentId === thread.id && !item.archived) : [], [thread, threads]);
  const activity = useMemo(() => thread ? Object.values(events).filter((event) => event.threadId === thread.id).sort((a, b) => b.timestamp.localeCompare(a.timestamp)) : [], [thread, events]);

  // Every agent selection is a fresh inspection session. Keep Chat as the
  // landing tab even when the previous agent was left on Overview, Subagents,
  // or Activity (including immediately after creating a new agent).
  useEffect(() => {
    if (selectedThreadId) setTab("chat");
  }, [selectedThreadId]);

  const timeline = useMemo(() => {
    const source = detail && typeof detail === "object" && "items" in detail && Array.isArray((detail as ChatTimeline).items) ? detail as ChatTimeline : connectionStatus === "demo" && thread ? demoTimeline(thread.provider ?? "codex", thread.id, thread.status) : undefined;
    if (!source) return undefined;
    return { ...source, items: source.items.map((item) => ({ ...item, path: item.path ? projectPath(folder?.path, item.path) : undefined, changes: item.changes?.map((change) => ({ ...change, path: projectPath(folder?.path, change.path) })) })) };
  }, [connectionStatus, detail, folder?.path, thread?.id, thread?.provider, thread?.status]);

  const loadPreview = useCallback(async (filePath: string, focus: boolean) => {
    const resolved = projectPath(folder?.path, filePath);
    const preview = await window.constellationDesktop?.files.preview(resolved);
    if (!preview) return;
    setPreviews((current) => ({ ...current, [resolved]: preview.dataUrl }));
    if (focus) setFocusedPreview({ path: resolved, dataUrl: preview.dataUrl, name: preview.name });
  }, [folder?.path]);
  const reveal = useCallback(async (filePath: string) => { await window.constellationDesktop?.files.reveal(projectPath(folder?.path, filePath)); }, [folder?.path]);
  const handlePreview = useCallback((filePath: string) => { void loadPreview(filePath, true); }, [loadPreview]);
  const handleReveal = useCallback((filePath: string) => { void reveal(filePath); }, [reveal]);

  const applyDetail = useCallback((response: unknown) => {
    const revision = timelineRevision(response);
    if (revision !== detailRevision.current) {
      detailRevision.current = revision;
      setDetail(response);
    }
    const runtime = response && typeof response === "object" && "status" in response ? String((response as { status?: string }).status) : "";
    const external = Boolean(response && typeof response === "object" && "externalRuntime" in response && (response as { externalRuntime?: boolean }).externalRuntime);
    if (selectedThreadId && ["running", "needs_attention", "failed", "completed", "idle"].includes(runtime) && !(external && (runtime === "idle" || runtime === "running"))) setThreadRuntimeStatus(selectedThreadId, runtime as ThreadStatus);
  }, [selectedThreadId, setThreadRuntimeStatus]);

  const refreshDetail = useCallback(async (showLoading = false) => {
    if (!selectedThreadId || !window.constellationDesktop || activeRequest.current) return;
    const request = Symbol(selectedThreadId);
    activeRequest.current = request;
    if (showLoading) setDetailLoading(true);
    setDetailError(undefined);
    const { rawId } = splitProviderThreadId(selectedThreadId);
    try {
      const response = threadProvider === "claude" ? await window.constellationDesktop.claude.readSession(rawId) : await window.constellationDesktop.codex.readThread(rawId);
      if (activeRequest.current === request) applyDetail(response);
    } catch (error) {
      if (activeRequest.current === request) setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      if (activeRequest.current === request) {
        activeRequest.current = undefined;
        if (showLoading) setDetailLoading(false);
      }
    }
  }, [applyDetail, selectedThreadId, threadProvider]);

  useEffect(() => {
    if (tab !== "chat" || !selectedThreadId || !window.constellationDesktop) return;
    activeRequest.current = undefined;
    detailRevision.current = "";
    setDetail(undefined); setDetailError(undefined); setFocusedPreview(undefined);
    void refreshDetail(true);
  }, [refreshDetail, selectedThreadId, tab]);

  useEffect(() => {
    const desktop = window.constellationDesktop;
    if (tab !== "chat" || !desktop || !selectedThreadId) return;
    window.clearTimeout(notificationTimer.current);
    notificationTimer.current = undefined;
    notificationPending.current = false;
    lastNotificationRefresh.current = 0;
    const schedule = () => {
      notificationPending.current = true;
      if (notificationTimer.current !== undefined) return;
      const elapsed = Date.now() - lastNotificationRefresh.current;
      // Notifications can arrive for every streamed token/tool event. Keep one
      // refresh queued and cap the cadence so the chat remains interactive.
      notificationTimer.current = window.setTimeout(async () => {
        notificationTimer.current = undefined;
        notificationPending.current = false;
        lastNotificationRefresh.current = Date.now();
        await refreshDetail(false);
        // If events arrived while the request was in flight, schedule one
        // trailing refresh instead of starving a continuous stream.
        if (notificationPending.current) schedule();
      }, Math.max(300, 900 - elapsed));
    };
    const remove = threadProvider === "claude" ? desktop.claude.onNotification(schedule) : desktop.codex.onNotification(schedule);
    return () => { window.clearTimeout(notificationTimer.current); notificationTimer.current = undefined; notificationPending.current = false; remove(); };
  }, [refreshDetail, selectedThreadId, tab, threadProvider]);

  useEffect(() => {
    if (tab !== "chat" || !window.constellationDesktop || connectionStatus === "demo") return;
    let cancelled = false;
    let timer: number | undefined;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await refreshDetail(false);
        if (!cancelled) schedule();
      }, timeline?.externalRuntime ? 8000 : 20000);
    };
    schedule();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [connectionStatus, refreshDetail, tab, timeline?.externalRuntime]);

  useEffect(() => {
    if (tab !== "chat" || !window.constellationDesktop) return;
    timeline?.items.filter((item) => item.kind === "image" && item.path).slice(-8).forEach((item) => {
      const resolved = projectPath(folder?.path, item.path!);
      if (!previews[resolved] && !previewRequests.current.has(resolved)) {
        previewRequests.current.add(resolved);
        void loadPreview(resolved, false).catch(() => undefined).finally(() => previewRequests.current.delete(resolved));
      }
    });
  }, [folder?.path, loadPreview, previews, tab, timeline]);

  const handleComposerSent = useCallback(async () => {
    if (!selectedThreadId) return;
    setThreadRuntimeStatus(selectedThreadId, "running");
    await syncFromSource();
    window.setTimeout(() => void refreshDetail(false), 450);
    window.setTimeout(() => void refreshDetail(false), 1600);
  }, [refreshDetail, selectedThreadId, setThreadRuntimeStatus, syncFromSource]);
  const handleComposerCancelled = useCallback(async () => {
    if (!selectedThreadId) return;
    setThreadRuntimeStatus(selectedThreadId, "waiting");
    await syncFromSource();
    window.setTimeout(() => void refreshDetail(false), 450);
  }, [refreshDetail, selectedThreadId, setThreadRuntimeStatus, syncFromSource]);

  const scheduleScrollToBottom = useCallback((force = false) => {
    if (!force && !pinnedToBottom.current) return;
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = undefined;
      const body = bodyRef.current;
      if (body && (force || pinnedToBottom.current)) body.scrollTop = body.scrollHeight;
    });
  }, []);

  const handleComposerRepin = useCallback(() => {
    scheduleScrollToBottom(true);
  }, [scheduleScrollToBottom]);

  const handleInspectorKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || tab !== "chat") return;
    if (focusedPreview) {
      event.preventDefault();
      event.stopPropagation();
      setFocusedPreview(undefined);
      return;
    }
    if (connectionStatus === "demo" || timeline?.status !== "running" || timeline.externalRuntime) return;
    event.preventDefault();
    event.stopPropagation();
    setCancelRequest((request) => request + 1);
  }, [connectionStatus, focusedPreview, tab, timeline?.externalRuntime, timeline?.status]);

  useEffect(() => () => {
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
  }, []);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || tab !== "chat") return;
    pinnedToBottom.current = true;
    scheduleScrollToBottom(true);
    const onScroll = () => {
      pinnedToBottom.current = body.scrollHeight - body.clientHeight - body.scrollTop <= 48;
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    const output = chatOutputRef.current;
    const observer = typeof ResizeObserver !== "undefined" && output
      ? new ResizeObserver(() => scheduleScrollToBottom())
      : undefined;
    if (observer && output) observer.observe(output);
    return () => {
      body.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [scheduleScrollToBottom, selectedThreadId, tab]);

  useEffect(() => {
    if (tab === "chat") scheduleScrollToBottom();
  }, [scheduleScrollToBottom, tab, timeline?.items.length, timeline?.updatedAt, focusedPreview]);

  if (!thread || !folder) return null;
  const live = connectionStatus !== "demo";
  const provider = providerMeta(thread.provider ?? "codex");
  const liveness = classifyLiveness({ status: thread.status, thread, events: activity, timeline });
  const displayedStatus = thread.status === "running" && liveness.state !== "active" ? (liveness.label || "Running") : timeline?.inferredRuntime ? "Active externally" : timeline?.externalRuntime && thread.status === "idle" ? "Synced" : statusLabel[thread.status];
  const action = (next: ThreadStatus) => void updateThread(thread.id, { status: next, summary: next === "running" ? "Resumed and working through the next bounded task." : next === "completed" ? "Marked complete." : thread.summary });
  const attention = thread.attention && !attentionDone;

  return <aside className={styles.panel} aria-label={`Inspector for ${thread.title}`} style={{ "--accent": provider.color } as React.CSSProperties} onKeyDownCapture={handleInspectorKeyDownCapture}>
    <div className={styles.header}>
      <div className={styles.context}><span className={styles.dot} /> <span>{folder.name}</span><span className={styles.path}>{folder.path}</span></div>
      <button className={styles.iconButton} onClick={onClose} aria-label="Close inspector"><X size={17} /></button>
      <p className={styles.key}><span className={styles.provider} style={{ color: provider.color, borderColor: `${provider.color}66` }}>{provider.shortLabel}</span>{thread.key}</p><h2>{thread.title}</h2>
      <div className={styles.meta}><span className={`${styles.status} ${styles[thread.status]} ${liveness.state === "possibly_stalled" ? styles.possiblyStalled : liveness.state === "quiet" ? styles.quiet : ""}`}><i />{displayedStatus}</span><span><Clock3 size={13} /> {formatTime(thread.startedAt)}</span><span>{thread.model}</span><span>{thread.reasoningEffort}</span></div>
      {thread.status === "running" && liveness.state !== "active" && liveness.state !== "unknown" && <div className={`${styles.livenessNotice} ${liveness.state === "possibly_stalled" ? styles.stalledNotice : ""}`} role="status"><CircleAlert size={14}/><span><strong>{formatLivenessNotice(liveness)}</strong>. This may be a long-running command; inspect the original {provider.label} task if it needs attention.</span></div>}
      <div className={styles.actions}>
        {isMapView && onBackToNow && <button className={styles.primary} onClick={onBackToNow}><RotateCcw size={14}/> Back to Now</button>}
        {!live && (thread.status === "running" ? <><button onClick={() => action("waiting")}><Pause size={14}/> Pause</button><button className={styles.danger} onClick={() => action("idle")}><Square size={13}/> Stop</button></> : <button className={styles.primary} onClick={() => action("running")}><Play size={14}/> {thread.status === "waiting" ? "Resume" : "Run again"}</button>)}
        <button onClick={() => onEdit?.(thread.id)}>Rename / edit</button><button onClick={() => onArchive?.(thread.id)}>Archive</button><button className={styles.danger} onClick={() => onDelete?.(thread.id)}>Delete permanently</button>
      </div>
    </div>
    {attention && <section className={styles.attention} aria-live="polite"><div className={styles.attentionTitle}><CircleAlert size={17}/> Action required</div><strong>{thread.attention?.kind === "approval" ? "Approval requested" : "Input needed"}</strong><p>{thread.attention?.message}</p><small>From {thread.title} · {thread.permission}</small>{live ? <p className={styles.liveNotice}>Respond in the original {provider.label} task. Constellation keeps this read-only until the provider reports the response.</p> : <div className={styles.attentionActions}><button className={styles.primary} onClick={() => setAttentionDone(true)}>Approve once</button><button onClick={() => setAttentionDone(true)}>Always allow…</button><button className={styles.reject} onClick={() => { setAttentionDone(true); action("failed"); }}>Reject</button></div>}</section>}
    <nav className={styles.tabs} aria-label="Inspector sections">{(["chat", "overview", "subagents", "activity"] as InspectorTab[]).map((name) => <button key={name} className={tab === name ? styles.activeTab : ""} onClick={() => setTab(name)} aria-selected={tab === name} role="tab">{name[0].toUpperCase() + name.slice(1)}{name === "subagents" && children.length ? <b>{children.length}</b> : null}</button>)}</nav>
    <div ref={bodyRef} className={styles.body} role="tabpanel">
      {tab === "overview" && <><section className={styles.card}><label>Objective</label><p className={styles.objective}>{thread.objective}</p><label>What it is doing now</label><p>{thread.summary}</p></section><dl className={styles.details}><div><dt>Provider</dt><dd style={{ color: provider.color }}>{provider.label}</dd></div><div><dt>Parent thread</dt><dd>{thread.parentId ? <button className={styles.link} onClick={() => selectThread(thread.parentId)}>{threads[thread.parentId]?.key ?? "Unknown"}<ChevronRight size={13}/></button> : "Root task"}</dd></div><div><dt>Permission mode</dt><dd>{thread.permission}</dd></div><div><dt>Branch / worktree</dt><dd>{thread.branch ?? "No branch"}</dd></div></dl></>}
      {tab === "subagents" && <section className={styles.listSection}><div className={styles.sectionHeading}><h3>Child threads</h3><button className={styles.primary} onClick={() => onAddSubagent?.(thread.id)}>Add subagent</button></div>{children.length ? children.map((child) => <button className={styles.child} key={child.id} onClick={() => selectThread(child.id)}><span className={`${styles.statusDot} ${styles[child.status]}`} /><span><strong>{child.title}</strong><small>{child.key} · {child.summary}</small></span><ChevronRight size={15}/></button>) : <p className={styles.empty}>No child threads yet. Add a bounded task to delegate through {provider.label}.</p>}</section>}
      {tab === "activity" && <section className={styles.timeline}>{activity.length ? activity.map((event) => <article key={event.id}><span className={`${styles.eventDot} ${styles[event.type]}`} /><div><strong>{event.title}</strong><p>{event.detail}</p><time>{formatTime(event.timestamp)}</time></div></article>) : <p className={styles.empty}>No activity recorded for this thread.</p>}</section>}
      {tab === "chat" && <section ref={chatOutputRef} className={styles.output}>{focusedPreview && <div className={styles.focusedPreview}><button onClick={() => setFocusedPreview(undefined)} aria-label="Close image preview"><X size={14}/></button><img src={focusedPreview.dataUrl} alt={focusedPreview.name}/><div><strong>{focusedPreview.name}</strong><small>{focusedPreview.path}</small><button onClick={() => void reveal(focusedPreview.path)}>Reveal in Finder</button></div></div>}<AgentChatTimeline timeline={timeline} liveness={liveness} provider={thread.provider ?? "codex"} loading={detailLoading} error={detailError} previews={previews} onPreview={handlePreview} onReveal={handleReveal} /></section>}
    </div>
    {tab === "chat" && <ThreadComposer thread={thread} cwd={folder.path} onSent={handleComposerSent} onCancelled={handleComposerCancelled} cancelRequest={cancelRequest} running={Boolean(live && timeline?.status === "running" && !timeline.externalRuntime)} onRepin={handleComposerRepin} />}
  </aside>;
}

export default InspectorPanel;

function projectPath(cwd: string | undefined, filePath: string) {
  if (!cwd || filePath.startsWith("/")) return filePath;
  return `${cwd.replace(/[\\/]$/, "")}/${filePath.replace(/^\.\//, "")}`;
}

function timelineRevision(value: unknown) {
  if (!value || typeof value !== "object" || !("items" in value) || !Array.isArray((value as ChatTimeline).items)) return "";
  const timeline = value as ChatTimeline;
  // Provider bridges expose updatedAt for streamed transcript snapshots. Use
  // that stable marker first; hashing every transcript body on every provider
  // notification made long chats compete with typing and scrolling.
  if (timeline.updatedAt) {
    const last = timeline.items[timeline.items.length - 1];
    return [timeline.threadId, timeline.updatedAt, timeline.status, timeline.sourceStatus, timeline.externalRuntime, timeline.inferredRuntime, timeline.turnCount, timeline.items.length, last?.id, last?.status, last?.text?.length ?? 0, last?.detail?.length ?? 0].join("|");
  }
  const items = timeline.items.map((item) => [
    item.id,
    item.status,
    item.text?.length ?? 0,
    item.text?.slice(-48) ?? "",
    item.detail?.length ?? 0,
    item.detail?.slice(-48) ?? "",
    item.path ?? "",
    item.changes?.map((change) => `${change.path}:${change.action}:${change.diff?.length ?? 0}`).join(",") ?? "",
  ].join(":"));
  return [timeline.threadId, timeline.status, timeline.sourceStatus, timeline.externalRuntime, timeline.inferredRuntime, timeline.turnCount, items.length, ...items].join("|");
}

function demoTimeline(provider: "codex" | "claude", threadId: string, status: ThreadStatus): ChatTimeline {
  const agent = provider === "claude" ? "Claude Code" : "Codex";
  const timelineStatus = status === "running" || status === "needs_attention" || status === "failed" || status === "completed" ? status : "idle";
  const stressFixture = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("demoLongChat") === "1";
  const stressItems: ChatTimeline["items"] = stressFixture ? Array.from({ length: 72 }, (_, index) => ({
    id: `demo-stress-${index}`,
    rawType: "commandExecution",
    kind: "tool",
    label: `Synthetic long item ${index + 1}`,
    title: `verify-long-output-${index + 1}`,
    text: `Synthetic wrapping fixture ${"unbroken".repeat(48)} /workspace/a/very/long/generated/path/that/must/stay/inside/the/chat/inspector/output-${index + 1}.txt`,
    status: "completed",
    timestamp: "2026-08-16T08:01:30.000Z",
  })) : [];
  return { provider, threadId, status: timelineStatus, turnCount: stressFixture ? 74 : 2, items: [
    { id: "demo-user-1", rawType: "userMessage", kind: "message", role: "user", text: "Audit the dashboard navigation and tighten the active-task experience.", status: "completed", timestamp: "2026-08-16T08:00:00.000Z" },
    { id: "demo-agent-1", rawType: "agentMessage", kind: "message", role: "assistant", text: `I’ll trace the current interaction, fix the highest-friction states, and verify the responsive layout.`, status: "completed", timestamp: "2026-08-16T08:00:12.000Z" },
    ...stressItems,
    { id: "demo-tool-1", rawType: "commandExecution", kind: "tool", label: "Ran command", title: "npm test", text: "12 tests passed", status: "completed", timestamp: "2026-08-16T08:01:20.000Z" },
    { id: "demo-file-1", rawType: "fileChange", kind: "file", label: "Changed 2 files", changes: [{ path: "components/navigation.tsx", action: "updated" }, { path: "components/task-panel.tsx", action: "updated" }], status: "completed", timestamp: "2026-08-16T08:02:00.000Z" },
    { id: "demo-agent-2", rawType: "agentMessage", kind: "message", role: "assistant", text: status === "running" ? `${agent} has the navigation pass working. I’m checking keyboard focus and the compact layout now.` : `${agent} finished the navigation pass and left the task ready for its next step.`, status: status === "running" ? "running" : "completed", timestamp: "2026-08-16T08:02:18.000Z" },
  ] };
}
