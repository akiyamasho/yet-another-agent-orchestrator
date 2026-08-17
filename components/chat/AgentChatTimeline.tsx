"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Bot, ChevronDown, ChevronRight, CircleAlert, FileCode2, Image as ImageIcon, LoaderCircle, Search, Sparkles, Terminal, UserRound, UsersRound } from "lucide-react";
import type { AgentProvider } from "@/lib/types";
import { formatLivenessNotice, type Liveness } from "@/lib/runtime/liveness";
import styles from "./AgentChatTimeline.module.css";

export type ChatTimelineItem = {
  id: string;
  turnId?: string;
  rawType: string;
  kind: "message" | "reasoning" | "plan" | "tool" | "toolResult" | "file" | "image" | "subagent" | "system";
  role?: "user" | "assistant";
  label?: string;
  title?: string;
  text?: string;
  detail?: string;
  path?: string;
  changes?: Array<{ path: string; action?: string; diff?: string }>;
  status: "running" | "completed" | "failed";
  timestamp?: string;
  exitCode?: number;
  durationMs?: number;
};

export type ChatTimeline = {
  provider: AgentProvider;
  threadId: string;
  status: "idle" | "running" | "needs_attention" | "completed" | "failed";
  sourceStatus?: string;
  externalRuntime?: boolean;
  inferredRuntime?: boolean;
  updatedAt?: string;
  items: ChatTimelineItem[];
  turnCount: number;
};

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const time = (value?: string) => value ? timeFormatter.format(new Date(value)) : "";
const PAGE_SIZE = 60;

export const AgentChatTimeline = memo(function AgentChatTimeline({ timeline, liveness, provider, loading, error, previews, onPreview, onReveal }: {
  timeline?: ChatTimeline;
  liveness?: Liveness;
  provider: AgentProvider;
  loading?: boolean;
  error?: string;
  previews?: Record<string, string>;
  onPreview?: (path: string) => void;
  onReveal?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const toggleExpanded = useCallback((id: string, defaultOpen: boolean) => setExpanded((current) => ({ ...current, [id]: !(current[id] ?? defaultOpen) })), []);
  const items = useMemo(() => timeline?.items ?? [], [timeline]);
  const hiddenCount = Math.max(0, items.length - visibleCount);
  const visibleItems = useMemo(() => items.slice(-visibleCount), [items, visibleCount]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); setExpanded({}); }, [timeline?.threadId]);

  if (loading && !timeline) return <div className={styles.state}><LoaderCircle className={styles.spin} size={18}/> Syncing chat…</div>;
  if (error) return <div className={`${styles.state} ${styles.error}`}><CircleAlert size={18}/>{error}</div>;
  if (!items.length) return <div className={styles.empty}><Bot size={22}/><strong>No synced messages yet</strong><p>Continue this {provider === "claude" ? "Claude Code" : "Codex"} task below. New messages and tool activity will appear here.</p></div>;

  return <div className={styles.timeline}>
    {timeline?.externalRuntime && <div className={styles.syncNotice}><span>{timeline.inferredRuntime ? "Active in another Codex window" : "Synced from Codex history"}</span><p>Chat content refreshes here. The other window keeps its exact stop/running signal and unpersisted tool events until you continue the task from Constellation.</p></div>}
    {hiddenCount > 0 && <button className={styles.earlier} onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>Show {Math.min(PAGE_SIZE, hiddenCount)} earlier items <span>{hiddenCount} hidden</span></button>}
    {visibleItems.map((item) => {
      if (item.kind === "message") return <Message key={item.id} item={item} provider={provider}/>;
      if (item.kind === "file") return <FileItem key={item.id} item={item} onReveal={onReveal}/>;
      if (item.kind === "image") return <ImageItem key={item.id} item={item} preview={item.path ? previews?.[item.path] : undefined} onPreview={onPreview} onReveal={onReveal}/>;
      const open = expanded[item.id] ?? item.kind === "plan";
      return <EventItem key={item.id} item={item} open={open} onToggle={toggleExpanded}/>;
    })}
    {timeline?.status === "running" && liveness?.state !== "possibly_stalled" && liveness?.state !== "quiet" && <div className={styles.live}><span/><strong>{provider === "claude" ? "Claude Code" : "Codex"} is working</strong><i/><i/><i/></div>}
    {timeline?.status === "running" && (liveness?.state === "possibly_stalled" || liveness?.state === "quiet") && <div className={`${styles.live} ${liveness.state === "possibly_stalled" ? styles.stalled : styles.quiet}`} role="status"><span/><strong>{formatLivenessNotice(liveness)}</strong></div>}
  </div>;
});

const Message = memo(function Message({ item, provider }: { item: ChatTimelineItem; provider: AgentProvider }) {
  const user = item.role === "user";
  return <article className={`${styles.message} ${user ? styles.user : styles.assistant}`}>
    <header>{user ? <UserRound size={14}/> : <Bot size={14}/>}<strong>{user ? "You" : provider === "claude" ? "Claude" : "Codex"}</strong>{item.timestamp && <time>{time(item.timestamp)}</time>}</header>
    <div>{item.text}</div>
  </article>;
}, (previous, next) => previous.provider === next.provider && sameItem(previous.item, next.item));

const FileItem = memo(function FileItem({ item, onReveal }: { item: ChatTimelineItem; onReveal?: (path: string) => void }) {
  return <article className={styles.files}><header><FileCode2 size={15}/><strong>{item.label || "File changes"}</strong></header>{(item.changes ?? []).map((change) => <div key={`${item.id}-${change.path}`}><button onClick={() => onReveal?.(change.path)} title={change.path}><span>{change.action || "changed"}</span>{change.path}</button>{change.diff && <details><summary>View diff</summary><pre>{change.diff}</pre></details>}</div>)}</article>;
}, (previous, next) => sameItem(previous.item, next.item) && previous.onReveal === next.onReveal);

const ImageItem = memo(function ImageItem({ item, preview, onPreview, onReveal }: { item: ChatTimelineItem; preview?: string; onPreview?: (path: string) => void; onReveal?: (path: string) => void }) {
  return <article className={styles.image}><header><ImageIcon size={15}/><strong>{item.label || "Image"}</strong></header>{preview && <button className={styles.imagePreview} onClick={() => item.path && onPreview?.(item.path)}><img src={preview} alt={item.path ? item.path.split(/[\\/]/).pop() : "Agent image"}/></button>}{item.path && <button className={styles.pathButton} onClick={() => onReveal?.(item.path!)}>{item.path}</button>}{item.text && <p>{item.text}</p>}</article>;
}, (previous, next) => sameItem(previous.item, next.item) && previous.preview === next.preview && previous.onPreview === next.onPreview && previous.onReveal === next.onReveal);

const EventItem = memo(function EventItem({ item, open, onToggle }: { item: ChatTimelineItem; open: boolean; onToggle: (id: string, defaultOpen: boolean) => void }) {
  return <article className={`${styles.event} ${styles[item.status]}`}>
    <button className={styles.eventHeader} onClick={() => onToggle(item.id, item.kind === "plan")} aria-expanded={open}>
      <EventIcon item={item}/><span><strong>{item.label || labelFor(item)}</strong>{item.title && <small>{item.title}</small>}</span>
      {item.status === "running" && <LoaderCircle className={styles.spin} size={14}/>} {open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
    </button>
    {open && (item.text || item.detail) && <pre>{item.text || item.detail}</pre>}
    {open && item.text && item.detail && <pre className={styles.detail}>{item.detail}</pre>}
  </article>;
}, (previous, next) => previous.open === next.open && sameItem(previous.item, next.item) && previous.onToggle === next.onToggle);

function sameItem(previous: ChatTimelineItem, next: ChatTimelineItem) {
  if (previous === next) return true;
  if (previous.id !== next.id || previous.kind !== next.kind || previous.rawType !== next.rawType || previous.status !== next.status) return false;
  if (previous.turnId !== next.turnId || previous.role !== next.role || previous.label !== next.label || previous.title !== next.title) return false;
  if (previous.text !== next.text || previous.detail !== next.detail || previous.path !== next.path || previous.timestamp !== next.timestamp || previous.exitCode !== next.exitCode || previous.durationMs !== next.durationMs) return false;
  const previousChanges = previous.changes ?? [];
  const nextChanges = next.changes ?? [];
  if (previousChanges.length !== nextChanges.length) return false;
  return previousChanges.every((change, index) => {
    const other = nextChanges[index];
    return change.path === other.path && change.action === other.action && change.diff === other.diff;
  });
}

function EventIcon({ item }: { item: ChatTimelineItem }) {
  if (item.kind === "reasoning") return <Sparkles size={15}/>;
  if (item.kind === "subagent") return <UsersRound size={15}/>;
  if (item.rawType === "webSearch") return <Search size={15}/>;
  return <Terminal size={15}/>;
}

function labelFor(item: ChatTimelineItem) {
  if (item.kind === "reasoning") return "Reasoning";
  if (item.kind === "plan") return "Plan";
  if (item.kind === "subagent") return "Subagent activity";
  if (item.kind === "tool") return "Tool activity";
  return item.rawType.replace(/([a-z])([A-Z])/g, "$1 $2");
}
