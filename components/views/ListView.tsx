"use client";

import { Fragment, useMemo } from "react";
import { Check, CircleAlert, Clock3, GitBranch, Pause, Play, UserRound } from "lucide-react";
import { useConstellationStore } from "@/lib/store/useConstellationStore";
import type { AgentThread, ThreadStatus } from "@/lib/types";
import styles from "./ListView.module.css";

const providerMeta = {
  codex: { label: "Codex", short: "C", color: "#7aa7b8" },
  claude: { label: "Claude Code", short: "A", color: "#d97757" },
} as const;

function getProvider(thread: AgentThread) {
  return providerMeta[thread.provider ?? "codex"];
}

const statusLabels: Record<ThreadStatus, string> = { running: "Running", waiting: "Waiting", needs_attention: "Needs you", completed: "Completed", failed: "Failed", idle: "Idle" };
const StatusIcon = ({ status }: { status: ThreadStatus }) => status === "running" ? <Play aria-hidden="true" /> : status === "waiting" ? <Pause aria-hidden="true" /> : status === "completed" ? <Check aria-hidden="true" /> : status === "needs_attention" || status === "failed" ? <CircleAlert aria-hidden="true" /> : <Clock3 aria-hidden="true" />;

function duration(thread: AgentThread) {
  const start = thread.startedAt ? new Date(thread.startedAt).getTime() : 0;
  const end = thread.finishedAt ? new Date(thread.finishedAt).getTime() : Date.now();
  if (!start) return "—";
  const minutes = Math.max(0, Math.round((end - start) / 60000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface ListViewProps { onNewAgent?: () => void; }

export function ListView({ onNewAgent }: ListViewProps) {
  const folders = useConstellationStore((s) => s.folders);
  const threads = useConstellationStore((s) => s.threads);
  const selectedFolderId = useConstellationStore((s) => s.selectedFolderId);
  const selectedThreadId = useConstellationStore((s) => s.selectedThreadId);
  const query = useConstellationStore((s) => s.query);
  const statusFilter = useConstellationStore((s) => s.statusFilter);
  const selectThread = useConstellationStore((s) => s.selectThread);
  const selectFolder = useConstellationStore((s) => s.selectFolder);
  const setStatusFilter = useConstellationStore((s) => s.setStatusFilter);

  const groups = useMemo(() => Object.values(folders).map((folder) => ({ folder, threads: Object.values(threads).filter((thread) => {
    const needle = query.trim().toLowerCase();
    const provider = getProvider(thread);
    return !thread.archived && thread.folderId === folder.id && (!selectedFolderId || thread.folderId === selectedFolderId) && (!statusFilter || thread.status === statusFilter) && (!needle || `${thread.key} ${thread.title} ${thread.objective} ${thread.summary} ${thread.branch ?? ""} ${thread.profile} ${provider.label} ${provider.short}`.toLowerCase().includes(needle));
  }) })).filter((group) => group.threads.length), [folders, threads, selectedFolderId, statusFilter, query]);

  return <section className={styles.view} aria-labelledby="list-heading">
    <div className={styles.heading}><div><p className={styles.kicker}>Operations / list</p><h2 id="list-heading">All tasks</h2><p className={styles.subtle}>{groups.reduce((n, g) => n + g.threads.length, 0)} visible threads across {groups.length} folder{groups.length === 1 ? "" : "s"}.</p></div><button className={styles.primary} onClick={onNewAgent} disabled={!onNewAgent} title={onNewAgent ? "Create an agent in the selected folder" : "Select a project folder first to create an agent"}>+ New agent</button></div>
    <div className={styles.filters} aria-label="Thread status filter">{([undefined, "running", "waiting", "needs_attention", "completed", "failed"] as const).map((status) => <button key={status ?? "all"} className={statusFilter === status ? styles.filterActive : styles.filter} onClick={() => setStatusFilter(status)} aria-pressed={statusFilter === status}>{status ? statusLabels[status] : "All statuses"}</button>)}</div>
    <div className={styles.tableWrap}><table><caption className={styles.srOnly}>Threads grouped by folder</caption><thead><tr><th scope="col">Task</th><th scope="col">Provider</th><th scope="col">Status</th><th scope="col">Parent</th><th scope="col">Model</th><th scope="col">Runtime</th><th scope="col">Attention</th></tr></thead><tbody>{groups.map(({ folder, threads: group }) => <Fragment key={folder.id}>{<tr className={styles.group}><th colSpan={7} scope="colgroup"><button onClick={() => selectFolder(folder.id)}><span className={styles.dot} style={{ background: folder.accent }} />{folder.name}<span className={styles.path}>{folder.path}</span></button></th></tr>}{group.map((thread) => { const parent = thread.parentId ? threads[thread.parentId] : undefined; const provider = getProvider(thread); return <tr key={thread.id} className={selectedThreadId === thread.id ? styles.selected : ""}><td><button className={styles.task} onClick={() => selectThread(thread.id)}><span className={`${styles.statusDot} ${styles[thread.status]}`}><StatusIcon status={thread.status} /></span><span><strong>{thread.title}</strong><small>{thread.key} · {thread.summary}</small></span></button></td><td><span className={styles.provider} style={{ color: provider.color, borderColor: provider.color }}><i>{provider.short}</i>{provider.label}</span></td><td><span className={`${styles.statusText} ${styles[thread.status]}`}><StatusIcon status={thread.status} />{statusLabels[thread.status]}</span></td><td>{parent ? <span className={styles.parent}><UserRound />{parent.title}</span> : <span className={styles.root}>Root task</span>}</td><td>{thread.model}<small className={styles.meta}>{thread.reasoningEffort} effort</small></td><td>{duration(thread)}</td><td>{thread.attention ? <span className={styles.attention}>{thread.attention.kind}</span> : <span className={styles.muted}>—</span>}</td></tr>; })}</Fragment>)}</tbody></table></div>
  </section>;
}
