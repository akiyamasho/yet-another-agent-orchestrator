"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Check, CircleAlert, Pause, Radio, Sparkles } from "lucide-react";
import { useConstellationStore } from "@/lib/store/useConstellationStore";
import type { AgentThread, FolderContext, ThreadStatus } from "@/lib/types";
import styles from "./MapView.module.css";

type FolderNodeData = { folder: FolderContext; count: number; attention: number; onSelect: () => void };
type ThreadNodeData = { thread: AgentThread; folder: FolderContext; depth: number; dimmed: boolean; onSelect: () => void };
type WorkspaceNodeData = { folderCount: number; threadCount: number };
type MapNode = Node<FolderNodeData | ThreadNodeData | WorkspaceNodeData>;

const statusLabel: Record<ThreadStatus, string> = {
  running: "Running", waiting: "Waiting", needs_attention: "Needs attention", completed: "Completed", failed: "Failed", idle: "Idle",
};

function StatusGlyph({ status }: { status: ThreadStatus }) {
  if (status === "completed") return <Check size={12} strokeWidth={3} />;
  if (status === "failed" || status === "needs_attention") return <CircleAlert size={12} />;
  if (status === "waiting") return <Pause size={11} />;
  if (status === "running") return <Radio size={11} />;
  return <span className={styles.idleDot} />;
}

const providerMeta = {
  codex: { label: "Codex", short: "C", color: "#7aa7b8" },
  claude: { label: "Claude Code", short: "A", color: "#d97757" },
} as const;

function getProvider(thread: AgentThread) {
  return providerMeta[thread.provider ?? "codex"];
}

function ConstellationHandles({ target = true, source = true }: { target?: boolean; source?: boolean }) {
  return <>
    {target && <><Handle id="target-top" type="target" position={Position.Top} className={styles.hiddenHandle}/><Handle id="target-right" type="target" position={Position.Right} className={styles.hiddenHandle}/><Handle id="target-bottom" type="target" position={Position.Bottom} className={styles.hiddenHandle}/><Handle id="target-left" type="target" position={Position.Left} className={styles.hiddenHandle}/></>}
    {source && <><Handle id="source-top" type="source" position={Position.Top} className={styles.hiddenHandle}/><Handle id="source-right" type="source" position={Position.Right} className={styles.hiddenHandle}/><Handle id="source-bottom" type="source" position={Position.Bottom} className={styles.hiddenHandle}/><Handle id="source-left" type="source" position={Position.Left} className={styles.hiddenHandle}/></>}
  </>;
}

function FolderNode({ data }: NodeProps<MapNode>) {
  const { folder, count, attention, onSelect } = data as FolderNodeData;
  const folderThreads = Object.values(useConstellationStore.getState().threads).filter((thread) => !thread.archived && thread.folderId === folder.id);
  const codexCount = folderThreads.filter((thread) => (thread.provider ?? "codex") === "codex").length;
  const claudeCount = folderThreads.filter((thread) => thread.provider === "claude").length;
  return <button className={styles.folderNode} style={{ "--accent": folder.accent } as React.CSSProperties} onClick={onSelect} aria-label={`Focus ${folder.name} folder, ${codexCount} Codex and ${claudeCount} Claude Code tasks`}>
    <ConstellationHandles/>
    <span className={styles.folderOrbit} />
    <span className={styles.folderGlyph}><Sparkles size={20} /></span>
    <strong>{folder.name}</strong>
    <small>{count} {count === 1 ? "thread" : "threads"}{attention ? ` · ${attention} needs you` : ""}</small>
    <span className={styles.providerCounts}><span className={styles.codexMark}>C {codexCount}</span><span className={styles.claudeMark}>A {claudeCount}</span></span>
  </button>;
}

function WorkspaceNode({ data }: NodeProps<MapNode>) {
  const { folderCount, threadCount } = data as WorkspaceNodeData;
  return <div className={styles.workspaceNode} aria-label={`${folderCount} projects and ${threadCount} agent tasks`}>
    <ConstellationHandles target={false}/>
    <span><Sparkles size={23}/></span><strong>Local agents</strong><small>{folderCount} projects · {threadCount} tasks</small>
  </div>;
}

function ThreadNode({ data }: NodeProps<MapNode>) {
  const { thread, folder, depth, dimmed, onSelect } = data as ThreadNodeData;
  const provider = getProvider(thread);
  return <button data-depth={Math.min(depth, 2)} className={`${styles.threadNode} ${styles[`status_${thread.status}`]} ${dimmed ? styles.dimmed : ""}`} style={{ "--accent": folder.accent, "--provider-color": provider.color, "--depth": depth } as React.CSSProperties} onClick={onSelect} aria-label={`${thread.key}: ${thread.title}, ${provider.label}, ${statusLabel[thread.status]}`}>
    <ConstellationHandles/>
    <span className={styles.statusRing}><StatusGlyph status={thread.status} /></span>
    <span className={styles.providerBadge} style={{ color: provider.color, borderColor: provider.color }} title={provider.label}>{provider.short}</span>
    <span className={styles.threadCopy}><strong>{thread.title}</strong><small>{thread.key} · {provider.label} · {statusLabel[thread.status]}</small></span>
    {thread.attention && <span className={styles.attentionBadge} aria-label="Attention required">!</span>}
  </button>;
}

const nodeTypes = { workspace: WorkspaceNode, folder: FolderNode, thread: ThreadNode };

function MapCanvas() {
  const flow = useReactFlow();
  const folderRecord = useConstellationStore((state) => state.folders);
  const threadRecord = useConstellationStore((state) => state.threads);
  const selectedFolderId = useConstellationStore((state) => state.selectedFolderId);
  const selectedThreadId = useConstellationStore((state) => state.selectedThreadId);
  const selectFolder = useConstellationStore((state) => state.selectFolder);
  const selectThread = useConstellationStore((state) => state.selectThread);
  const reducedMotion = useRef(false);

  const folders = useMemo(() => Object.values(folderRecord), [folderRecord]);
  const threads = useMemo(
    () => Object.values(threadRecord).filter((thread) => !thread.archived),
    [threadRecord],
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { reducedMotion.current = query.matches; };
    update(); query.addEventListener("change", update); return () => query.removeEventListener("change", update);
  }, []);

  const visibleThreads = useMemo(() => threads.filter((thread) => !selectedFolderId || thread.folderId === selectedFolderId), [threads, selectedFolderId]);
  const visibleFolderIds = useMemo(
    () => selectedFolderId ? new Set([selectedFolderId]) : new Set(folders.map((folder) => folder.id)),
    [folders, selectedFolderId],
  );
  const relatedThreadIds = useMemo(() => {
    const related = new Set<string>();
    if (!selectedThreadId) return related;
    let cursor: string | undefined = selectedThreadId;
    while (cursor && !related.has(cursor)) { related.add(cursor); cursor = threadRecord[cursor]?.parentId; }
    let changed = true;
    while (changed) {
      changed = false;
      visibleThreads.forEach((thread) => { if (thread.parentId && related.has(thread.parentId) && !related.has(thread.id)) { related.add(thread.id); changed = true; } });
    }
    return related;
  }, [selectedThreadId, threadRecord, visibleThreads]);
  const nodes = useMemo<MapNode[]>(() => {
    const result: MapNode[] = [];
    if (!selectedFolderId) result.push({ id: "workspace", type: "workspace", position: { x: -90, y: -76 }, data: { folderCount: folders.length, threadCount: threads.length } });
    folders.forEach((folder, folderIndex) => {
      if (!visibleFolderIds.has(folder.id)) return;
      const angle = (folderIndex / Math.max(folders.length, 1)) * Math.PI * 2 - Math.PI / 2 + 0.18 + Math.sin((folderIndex + 1) * 1.9) * 0.055;
      const overviewRadius = Math.max(430, Math.min(920, folders.length * 62));
      const orbitRadius = overviewRadius * (0.93 + (folderIndex % 3) * 0.055);
      const fx = selectedFolderId ? -90 : Math.cos(angle) * orbitRadius - 90;
      const fy = selectedFolderId ? -76 : Math.sin(angle) * orbitRadius - 76;
      const folderThreads = visibleThreads.filter((thread) => thread.folderId === folder.id);
      const roots = folderThreads.filter((thread) => !thread.parentId);
      result.push({ id: `folder:${folder.id}`, type: "folder", position: { x: fx, y: fy }, data: { folder, count: folderThreads.length, attention: folderThreads.filter((thread) => thread.status === "needs_attention").length, onSelect: () => { selectFolder(folder.id); selectThread(undefined); } } });
      if (!selectedFolderId) return;
      const byId = new Map(folderThreads.map((thread) => [thread.id, thread]));
      let selectedRootId = selectedThreadId;
      while (selectedRootId && byId.get(selectedRootId)?.parentId) selectedRootId = byId.get(selectedRootId)?.parentId;
      const rootRadius = Math.max(440, Math.min(980, roots.length * 43));
      const addThread = (thread: AgentThread, threadAngle: number, radius: number, depth: number, includeChildren: boolean) => {
        const x = Math.cos(threadAngle) * radius - 110;
        const y = Math.sin(threadAngle) * radius - 34;
        result.push({ id: thread.id, type: "thread", position: { x, y }, data: { thread, folder, depth, dimmed: Boolean(selectedThreadId && !relatedThreadIds.has(thread.id)), onSelect: () => selectThread(thread.id) } });
        if (!includeChildren) return;
        const children = folderThreads.filter((child) => child.parentId === thread.id);
        const step = Math.min(0.34, Math.max(0.16, 0.72 / Math.max(children.length, 1)));
        children.forEach((child, childIndex) => addThread(child, threadAngle + (childIndex - (children.length - 1) / 2) * step, radius + 220, depth + 1, true));
      };
      roots.forEach((thread, rootIndex) => {
        const rootAngle = (rootIndex / Math.max(roots.length, 1)) * Math.PI * 2 - Math.PI / 2 + 0.28 + Math.sin((rootIndex + 1) * 2.1) * 0.035;
        const variedRadius = rootRadius * (0.92 + (rootIndex % 4) * 0.035);
        addThread(thread, rootAngle, variedRadius, 0, selectedRootId === thread.id);
      });
    });
    return result;
  }, [folders, threads.length, visibleThreads, selectedFolderId, selectedThreadId, visibleFolderIds, selectFolder, selectThread, relatedThreadIds]);

  const edges = useMemo<Edge[]>(() => {
    const result: Edge[] = [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const radialHandles = (source: string, target: string) => {
      const from = nodeById.get(source)?.position;
      const to = nodeById.get(target)?.position;
      if (!from || !to) return {};
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      if (Math.abs(dx) > Math.abs(dy)) return dx > 0
        ? { sourceHandle: "source-right", targetHandle: "target-left" }
        : { sourceHandle: "source-left", targetHandle: "target-right" };
      return dy > 0
        ? { sourceHandle: "source-bottom", targetHandle: "target-top" }
        : { sourceHandle: "source-top", targetHandle: "target-bottom" };
    };
    if (!selectedFolderId) folders.forEach((folder) => {
      const target = `folder:${folder.id}`;
      if (nodeById.has(target)) result.push({ id: `edge:workspace:${folder.id}`, source: "workspace", target, ...radialHandles("workspace", target), type: "straight", style: { stroke: folder.accent, strokeWidth: 1.2, opacity: 0.48 } });
    });
    visibleThreads.forEach((thread) => {
      const source = thread.parentId ?? `folder:${thread.folderId}`;
      if (!nodes.some((node) => node.id === source) || !nodes.some((node) => node.id === thread.id)) return;
      const providerColor = getProvider(thread).color;
      const related = !selectedThreadId || relatedThreadIds.has(thread.id) || Boolean(thread.parentId && relatedThreadIds.has(thread.parentId));
      result.push({ id: `edge:${source}:${thread.id}`, source, target: thread.id, ...radialHandles(source, thread.id), type: "straight", animated: thread.status === "running", style: { stroke: thread.parentId ? providerColor : (folders.find((folder) => folder.id === thread.folderId)?.accent || providerColor), strokeWidth: thread.parentId ? 1.2 : 1.45, strokeDasharray: thread.parentId ? "3 7" : undefined, opacity: related ? 0.64 : 0.1 } });
    });
    return result;
  }, [visibleThreads, nodes, folders, selectedThreadId, selectedFolderId, relatedThreadIds]);

  useEffect(() => {
    const timer = window.setTimeout(() => flow.fitView({ padding: 0.26, duration: reducedMotion.current ? 0 : 560, nodes: nodes.map((node) => ({ id: node.id })) }), 40);
    return () => window.clearTimeout(timer);
  }, [selectedFolderId, selectedThreadId, nodes.length, flow]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { if (selectedThreadId) selectThread(undefined); else if (selectedFolderId) selectFolder(undefined); }
      if (event.key === "F" || event.key === "f") { if (selectedThreadId) flow.fitView({ nodes: [{ id: selectedThreadId }], padding: 0.7, duration: reducedMotion.current ? 0 : 420 }); }
      if (event.shiftKey && event.key === "!") { selectFolder(undefined); selectThread(undefined); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [flow, selectedFolderId, selectedThreadId, selectFolder, selectThread]);

  return <div className={styles.canvas} onDoubleClick={(event) => { if ((event.target as HTMLElement).classList.contains("react-flow__pane")) { selectFolder(undefined); selectThread(undefined); flow.fitView({ padding: 0.2, duration: reducedMotion.current ? 0 : 500 }); } }}>
    <div className={styles.atmosphere} aria-hidden="true"><span /><span /><span /><span /><span /></div>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.25} maxZoom={1.8} proOptions={{ hideAttribution: true }}>
      <Background color="#25314b" gap={48} size={1} />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
    <div className={styles.legend} aria-label="Map legend"><span><i className={styles.legendLine} /> delegation</span><span><i className={`${styles.legendDot} ${styles.running}`} /> running</span><span><i className={`${styles.legendDot} ${styles.attention}`} /> needs you</span></div>
    <div className={styles.hints}>Esc close / move up&nbsp;&nbsp; · &nbsp;&nbsp;F focus selection&nbsp;&nbsp; · &nbsp;&nbsp;⇧1 overview</div>
  </div>;
}

export function MapView() { return <ReactFlowProvider><MapCanvas /></ReactFlowProvider>; }

export default MapView;
