"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
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
type MapNode = Node<FolderNodeData | ThreadNodeData>;

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

function FolderNode({ data }: NodeProps<MapNode>) {
  const { folder, count, attention, onSelect } = data as FolderNodeData;
  const folderThreads = Object.values(useConstellationStore.getState().threads).filter((thread) => !thread.archived && thread.folderId === folder.id);
  const codexCount = folderThreads.filter((thread) => (thread.provider ?? "codex") === "codex").length;
  const claudeCount = folderThreads.filter((thread) => thread.provider === "claude").length;
  return <button className={styles.folderNode} style={{ "--accent": folder.accent } as React.CSSProperties} onClick={onSelect} aria-label={`Focus ${folder.name} folder, ${codexCount} Codex and ${claudeCount} Claude Code tasks`}>
    <Handle type="source" position={Position.Bottom} className={styles.hiddenHandle} />
    <span className={styles.folderOrbit} />
    <span className={styles.folderGlyph}><Sparkles size={20} /></span>
    <strong>{folder.name}</strong>
    <small>{count} {count === 1 ? "thread" : "threads"}{attention ? ` · ${attention} needs you` : ""}</small>
    <span className={styles.providerCounts}><span className={styles.codexMark}>C {codexCount}</span><span className={styles.claudeMark}>A {claudeCount}</span></span>
  </button>;
}

function ThreadNode({ data }: NodeProps<MapNode>) {
  const { thread, folder, depth, dimmed, onSelect } = data as ThreadNodeData;
  const provider = getProvider(thread);
  return <button className={`${styles.threadNode} ${styles[`status_${thread.status}`]} ${dimmed ? styles.dimmed : ""}`} style={{ "--accent": folder.accent, "--provider-color": provider.color, "--depth": depth } as React.CSSProperties} onClick={onSelect} aria-label={`${thread.key}: ${thread.title}, ${provider.label}, ${statusLabel[thread.status]}`}>
    <Handle type="target" position={Position.Top} className={styles.hiddenHandle} />
    <Handle type="source" position={Position.Bottom} className={styles.hiddenHandle} />
    <span className={styles.statusRing}><StatusGlyph status={thread.status} /></span>
    <span className={styles.providerBadge} style={{ color: provider.color, borderColor: provider.color }} title={provider.label}>{provider.short}</span>
    <span className={styles.threadCopy}><strong>{thread.title}</strong><small>{thread.key} · {provider.label} · {statusLabel[thread.status]}</small></span>
    {thread.attention && <span className={styles.attentionBadge} aria-label="Attention required">!</span>}
  </button>;
}

const nodeTypes = { folder: FolderNode, thread: ThreadNode };

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
  const nodes = useMemo<MapNode[]>(() => {
    const result: MapNode[] = [];
    const center = { x: 0, y: 0 };
    folders.forEach((folder, folderIndex) => {
      if (!visibleFolderIds.has(folder.id)) return;
      const angle = (folderIndex / Math.max(folders.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const radius = selectedFolderId ? 0 : 560;
      const fx = center.x + Math.cos(angle) * radius;
      const fy = center.y + Math.sin(angle) * radius;
      const folderThreads = visibleThreads.filter((thread) => thread.folderId === folder.id);
      const roots = folderThreads.filter((thread) => !thread.parentId);
      result.push({ id: `folder:${folder.id}`, type: "folder", position: { x: fx, y: fy }, data: { folder, count: folderThreads.length, attention: folderThreads.filter((thread) => thread.status === "needs_attention").length, onSelect: () => { selectFolder(folder.id); selectThread(undefined); } } });
      if (!selectedFolderId) return;
      const byId = new Map(folderThreads.map((thread) => [thread.id, thread]));
      let selectedRootId = selectedThreadId;
      while (selectedRootId && byId.get(selectedRootId)?.parentId) selectedRootId = byId.get(selectedRootId)?.parentId;
      const addThread = (thread: AgentThread, x: number, y: number, depth: number, includeChildren: boolean) => {
        result.push({ id: thread.id, type: "thread", position: { x, y }, data: { thread, folder, depth, dimmed: Boolean(selectedThreadId && selectedThreadId !== thread.id), onSelect: () => selectThread(thread.id) } });
        if (!includeChildren) return;
        const children = folderThreads.filter((child) => child.parentId === thread.id);
        children.forEach((child, childIndex) => addThread(child, x + (childIndex - (children.length - 1) / 2) * Math.max(190, 250 - depth * 20), y + 132, depth + 1, true));
      };
      roots.forEach((thread, rootIndex) => {
        const tx = selectedFolderId ? -340 + (rootIndex % 2) * 680 : fx - 160 + (rootIndex % 2) * 320;
        const ty = selectedFolderId ? -190 + Math.floor(rootIndex / 2) * 200 : fy + 130 + Math.floor(rootIndex / 2) * 170;
        addThread(thread, tx, ty, 0, selectedRootId === thread.id);
      });
    });
    return result;
  }, [folders, visibleThreads, selectedFolderId, selectedThreadId, visibleFolderIds, selectFolder, selectThread]);

  const edges = useMemo<Edge[]>(() => {
    const result: Edge[] = [];
    visibleThreads.forEach((thread) => {
      const source = thread.parentId ?? `folder:${thread.folderId}`;
      if (!nodes.some((node) => node.id === source) || !nodes.some((node) => node.id === thread.id)) return;
      const providerColor = getProvider(thread).color;
      result.push({ id: `edge:${source}:${thread.id}`, source, target: thread.id, type: "smoothstep", animated: thread.status === "running", style: { stroke: providerColor, strokeWidth: thread.parentId ? 1.5 : 2, opacity: selectedThreadId && selectedThreadId !== thread.id && selectedThreadId !== thread.parentId ? 0.18 : 0.65 }, markerEnd: { type: MarkerType.ArrowClosed, color: providerColor } });
    });
    return result;
  }, [visibleThreads, nodes, folders, selectedThreadId]);

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
    <div className={styles.core} aria-hidden="true"><span><Sparkles size={18} /></span><small>LOCAL WORKSPACE</small></div>
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
