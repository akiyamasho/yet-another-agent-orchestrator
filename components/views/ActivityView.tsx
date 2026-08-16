"use client";

import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, FileText, MessageSquare, Wrench } from "lucide-react";
import { useConstellationStore } from "@/lib/store/useConstellationStore";
import type { AgentEvent, EventType } from "@/lib/types";
import styles from "./ActivityView.module.css";

const eventLabels: Record<EventType, string> = { message: "Messages", tool: "Tools", file: "Files", approval: "Approvals", error: "Errors", status: "Status" };
const EventIcon = ({ type }: { type: EventType }) => type === "tool" ? <Wrench /> : type === "file" ? <FileText /> : type === "message" ? <MessageSquare /> : type === "approval" || type === "error" ? <AlertCircle /> : <CheckCircle2 />;

export interface ActivityViewProps { onLocate?: (threadId: string) => void; }

export function ActivityView({ onLocate }: ActivityViewProps) {
  const folders = useConstellationStore((s) => s.folders); const threads = useConstellationStore((s) => s.threads); const events = useConstellationStore((s) => s.events);
  const selectedFolderId = useConstellationStore((s) => s.selectedFolderId); const query = useConstellationStore((s) => s.query); const selectThread = useConstellationStore((s) => s.selectThread);
  const [kind, setKind] = useState<EventType | "all">("all");
  const visible = useMemo(() => Object.values(events).filter((event) => { const thread = threads[event.threadId]; if (!thread || thread.archived) return false; const needle = query.trim().toLowerCase(); return (!selectedFolderId || thread.folderId === selectedFolderId) && (kind === "all" || event.type === kind) && (!needle || `${event.title} ${event.detail ?? ""} ${thread.title} ${thread.key}`.toLowerCase().includes(needle)); }).sort((a,b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)), [events, threads, selectedFolderId, query, kind]);
  const needsYou = visible.filter((event) => event.type === "approval" || event.type === "error" || threads[event.threadId]?.status === "needs_attention");
  const updates = visible.filter((event) => !needsYou.some((item) => item.id === event.id));
  const renderEvent = (event: AgentEvent) => { const thread = threads[event.threadId]; const folder = thread ? folders[thread.folderId] : undefined; if (!thread) return null; return <li key={event.id} className={`${styles.event} ${event.type === "approval" || event.type === "error" ? styles.urgent : ""}`}><button onClick={() => selectThread(thread.id)} className={styles.eventButton} aria-label={`Open ${thread.title}: ${event.title}`}><span className={styles.icon} style={{ color: folder?.accent }}><EventIcon type={event.type} /></span><span className={styles.body}><span className={styles.eventTitle}>{event.title}</span><span className={styles.eventMeta}><b>{thread.key}</b> · {thread.title} · {folder?.name}</span>{event.detail && <span className={styles.detail}>{event.detail}</span>}</span><time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></button>{onLocate && <button className={styles.locate} onClick={() => onLocate(thread.id)}>Locate on map</button>}</li>; };
  return <section className={styles.view} aria-labelledby="activity-heading"><div className={styles.heading}><div><p className={styles.kicker}>Operations / activity</p><h2 id="activity-heading">Activity</h2><p className={styles.subtle}>A cross-folder trace of what your agents are doing.</p></div><span className={styles.count}>{visible.length} events</span></div><div className={styles.filters} aria-label="Activity type filter">{(["all", "status", "message", "tool", "file", "approval", "error"] as const).map((item) => <button key={item} onClick={() => setKind(item)} className={kind === item ? styles.active : ""} aria-pressed={kind === item}>{item === "all" ? "All activity" : eventLabels[item]}</button>)}</div>{needsYou.length > 0 && <section className={styles.needs} aria-labelledby="needs-heading"><div className={styles.sectionHead}><h3 id="needs-heading">Needs you</h3><span>{needsYou.length}</span></div><ul>{needsYou.map(renderEvent)}</ul></section>}<section className={styles.timeline} aria-labelledby="updates-heading"><div className={styles.sectionHead}><h3 id="updates-heading">Latest updates</h3><span>{updates.length}</span></div>{updates.length ? <ul>{updates.map(renderEvent)}</ul> : <p className={styles.empty}>No activity matches these filters.</p>}</section></section>;
}
