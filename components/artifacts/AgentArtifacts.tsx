"use client";

import { AlertCircle, Check, ChevronDown, Clock3, FileCode2, FileImage, ExternalLink, LoaderCircle, TerminalSquare } from "lucide-react";
import { useMemo, useState } from "react";
import styles from "./AgentArtifacts.module.css";

export type ArtifactProvider = "codex" | "claude" | "unknown";
export type ArtifactKind = "task" | "image" | "file" | "message" | "command";
export type ArtifactStatus = "running" | "waiting" | "completed" | "failed" | "pending" | "unknown";

export interface AgentArtifact {
  id: string;
  kind: ArtifactKind;
  provider?: ArtifactProvider;
  title?: string;
  text?: string;
  path?: string;
  previewUrl?: string;
  command?: string;
  role?: string;
  status?: ArtifactStatus;
  timestamp?: string;
  changed?: boolean;
  meta?: string;
}

export interface AgentArtifactsProps {
  artifacts: AgentArtifact[];
  onPreview?: (path: string, artifact: AgentArtifact) => void;
  onReveal?: (path: string, artifact: AgentArtifact) => void;
  loading?: boolean;
  error?: string;
  emptyLabel?: string;
  className?: string;
}

const statusLabel: Record<ArtifactStatus, string> = {
  running: "Running", waiting: "Waiting", completed: "Done", failed: "Failed", pending: "Queued", unknown: "Unknown",
};

export function AgentArtifacts({ artifacts, onPreview, onReveal, loading, error, emptyLabel = "No task output or file activity yet.", className }: AgentArtifactsProps) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? artifacts : artifacts.slice(0, 18);
  const tasks = visible.filter((item) => item.kind === "task");
  const images = visible.filter((item) => item.kind === "image");
  const files = visible.filter((item) => item.kind === "file");
  const messages = visible.filter((item) => item.kind === "message" || item.kind === "command");

  if (loading) return <section className={`${styles.root} ${className ?? ""}`} aria-busy="true" aria-label="Loading agent artifacts"><div className={styles.loading}><LoaderCircle className={styles.spin} size={18} /><span>Reading the live transcript…</span></div><div className={styles.skeletons}><i /><i /><i /></div></section>;
  if (error) return <section className={`${styles.root} ${className ?? ""}`} role="alert"><div className={styles.error}><AlertCircle size={17} /><span>{error}</span></div></section>;
  if (!artifacts.length) return <section className={`${styles.root} ${className ?? ""}`}><div className={styles.empty}><Clock3 size={18} /><span>{emptyLabel}</span></div></section>;

  return <section className={`${styles.root} ${className ?? ""}`} aria-label="Agent tasks and artifacts">
    {tasks.length > 0 && <ArtifactSection title="Tasks" count={tasks.length} icon={<Check size={14} />}><div className={styles.tasks}>{tasks.map((item) => <TaskRow key={item.id} item={item} />)}</div></ArtifactSection>}
    {images.length > 0 && <ArtifactSection title="Images" count={images.length} icon={<FileImage size={14} />}><div className={styles.imageGrid}>{images.map((item) => <ImageCard key={item.id} item={item} onPreview={onPreview} onReveal={onReveal} />)}</div></ArtifactSection>}
    {files.length > 0 && <ArtifactSection title="Changed files" count={files.length} icon={<FileCode2 size={14} />}><div className={styles.files}>{files.map((item) => <FileRow key={item.id} item={item} onPreview={onPreview} onReveal={onReveal} />)}</div></ArtifactSection>}
    {messages.length > 0 && <ArtifactSection title="Transcript" count={messages.length} icon={<TerminalSquare size={14} />}><div className={styles.messages}>{messages.map((item) => <MessageRow key={item.id} item={item} />)}</div></ArtifactSection>}
    {artifacts.length > 18 && <button className={styles.more} onClick={() => setShowAll((value) => !value)}>{showAll ? "Show less" : `Show all ${artifacts.length} artifacts`}<ChevronDown className={showAll ? styles.flip : ""} size={14} /></button>}
  </section>;
}

function ArtifactSection({ title, count, icon, children }: { title: string; count: number; icon: React.ReactNode; children: React.ReactNode }) {
  return <section className={styles.section}><header className={styles.sectionHeader}><span className={styles.sectionTitle}>{icon}{title}</span><span className={styles.count}>{count}</span></header>{children}</section>;
}

function TaskRow({ item }: { item: AgentArtifact }) {
  const status = item.status ?? "unknown";
  return <article className={styles.task}><span className={`${styles.status} ${styles[status]}`} aria-label={statusLabel[status]}>{status === "completed" ? <Check size={12} /> : status === "running" ? <i /> : null}</span><div className={styles.content}><strong>{item.title || item.text || "Untitled task"}</strong>{item.text && item.title ? <p>{item.text}</p> : null}<small>{item.provider && item.provider !== "unknown" ? item.provider : "agent"}{item.timestamp ? ` · ${formatTime(item.timestamp)}` : ""}{item.meta ? ` · ${item.meta}` : ""}</small></div><span className={`${styles.statusText} ${styles[status]}`}>{statusLabel[status]}</span></article>;
}

function ImageCard({ item, onPreview, onReveal }: { item: AgentArtifact; onPreview?: AgentArtifactsProps["onPreview"]; onReveal?: AgentArtifactsProps["onReveal"] }) {
  const label = item.title || basename(item.path) || "Generated image";
  return <article className={styles.imageCard}><button className={styles.preview} onClick={() => item.path && onPreview?.(item.path, item)} aria-label={`Preview ${label}`}>{item.previewUrl ? <img src={item.previewUrl} alt={label} loading="lazy" /> : <FileImage size={22} />}</button><div className={styles.imageInfo}><strong title={label}>{label}</strong>{item.path && <small title={item.path}>{item.path}</small>}<div className={styles.rowActions}>{item.path && <button onClick={() => onPreview?.(item.path!, item)}>Preview</button>}{item.path && <button onClick={() => onReveal?.(item.path!, item)}><ExternalLink size={12} /> Reveal</button>}</div></div></article>;
}

function FileRow({ item, onReveal }: { item: AgentArtifact; onPreview?: AgentArtifactsProps["onPreview"]; onReveal?: AgentArtifactsProps["onReveal"] }) {
  const label = item.path || item.title || "Unnamed file";
  return <article className={styles.file}><FileCode2 size={16} /><div className={styles.content}><strong title={label}>{item.title || basename(label)}</strong><small title={label}>{label}</small></div>{item.path && <button className={styles.iconAction} onClick={() => onReveal?.(item.path!, item)} aria-label={`Reveal ${label} in Finder`}><ExternalLink size={13} /> Reveal</button>}</article>;
}

function MessageRow({ item }: { item: AgentArtifact }) {
  const text = item.command || item.text || "";
  return <article className={`${styles.message} ${item.kind === "command" ? styles.command : ""}`}><span className={styles.role}>{item.kind === "command" ? "CMD" : (item.role || "AGENT").toUpperCase()}</span><p>{text}</p>{item.timestamp && <time>{formatTime(item.timestamp)}</time>}</article>;
}

const formatTime = (value: string) => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date); };
const basename = (value?: string) => value?.split(/[\\/]/).pop() || value;

export interface ParseArtifactsOptions { provider?: ArtifactProvider; max?: number; }

/** Extracts useful UI artifacts from App Server thread/read or Claude Code JSONL without requiring a provider SDK. */
export function parseAgentArtifacts(input: unknown, options: ParseArtifactsOptions = {}): AgentArtifact[] {
  const provider = options.provider ?? "unknown";
  const records = toRecords(input);
  const result: AgentArtifact[] = [];
  const seen = new Set<string>();
  const add = (artifact: Omit<AgentArtifact, "id">, key?: string) => { const identity = key || `${artifact.kind}:${artifact.path || artifact.title || artifact.text || artifact.command || result.length}`; if (!identity || seen.has(identity)) return; seen.add(identity); result.push({ ...artifact, id: `artifact-${result.length + 1}` }); };
  const visit = (value: unknown, parent?: Record<string, unknown>, index = 0) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((entry, i) => visit(entry, parent, i)); return; }
    const record = value as Record<string, unknown>;
    const type = String(record.type || record.kind || "").toLowerCase();
    const timestamp = stringValue(record.timestamp) || stringValue(record.createdAt) || stringValue(record.created_at);
    const status = statusFrom(record.status || record.state || record.phase || record.completed);
    const title = stringValue(record.title) || stringValue(record.name) || stringValue(record.task) || stringValue(record.subject) || stringValue(record.step) || stringValue(record.content);
    const text = stringValue(record.text) || stringValue(record.message) || stringValue(record.summary) || contentText(record.content);
    const command = stringValue(record.command) || stringValue(record.cmd) || (type.includes("command") ? stringValue(record.input) : undefined);
    if (isTaskRecord(record, type, parent)) add({ kind: "task", provider, title: title || text || "Task", text: title ? text : undefined, status, timestamp, meta: stringValue(record.model) }, `task:${stringValue(record.id) || title || index}`);
    if (command) add({ kind: "command", provider, command, text: command, role: "command", timestamp }, `command:${stringValue(record.id) || command}`);
    if (text && !isTaskRecord(record, type, parent) && !command && (type.includes("message") || type === "assistant" || type === "user" || type === "system" || type === "agentmessage" || type === "plan")) add({ kind: "message", provider, text, role: roleFor(type), timestamp }, `message:${stringValue(record.id) || text}`);
    const imageUrl = imageData(record) || imageData(parent);
    const path = pathValue(record);
    if (imageUrl || isImagePath(path)) add({ kind: "image", provider, path, previewUrl: imageUrl, title: title || basename(path) || "Generated image", timestamp }, `image:${path || imageUrl}`);
    else if (path && isUsefulFilePath(path)) add({ kind: "file", provider, path, title: title || basename(path), changed: Boolean(record.changed || record.modified), timestamp }, `file:${path}`);
    for (const key of ["changedFiles", "changed_files", "files", "fileChanges", "attachments", "outputs", "todos", "tasks"]) { const nested = record[key]; if (Array.isArray(nested)) nested.forEach((entry, i) => visit(typeof entry === "string" ? (key === "todos" || key === "tasks" ? { type: "task", title: entry } : { path: entry, changed: key.toLowerCase().includes("change") }) : (key === "todos" || key === "tasks") && entry && typeof entry === "object" ? { ...(entry as Record<string, unknown>), type: (entry as Record<string, unknown>).type || "task" } : entry, record, i)); }
    for (const [key, nested] of Object.entries(record)) if (!["content", "files", "changedFiles", "changed_files", "attachments", "outputs", "fileChanges", "todos", "tasks"].includes(key) && nested && typeof nested === "object") visit(nested, record, index);
  };
  records.forEach((record, index) => visit(record, undefined, index));
  return options.max ? result.slice(0, options.max) : result;
}

function toRecords(input: unknown): unknown[] { if (typeof input === "string") return input.split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { return line ? { type: "message", text: line } : null; } }).filter(Boolean); if (Array.isArray(input)) return input; if (input && typeof input === "object") { const object = input as Record<string, unknown>; return Array.isArray(object.records) ? object.records : [input]; } return []; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : value != null && (typeof value === "number" || typeof value === "boolean") ? String(value) : undefined; }
function contentText(value: unknown): string | undefined { if (typeof value === "string") return value; if (!Array.isArray(value)) return undefined; const text = value.map((part) => typeof part === "string" ? part : part && typeof part === "object" ? stringValue((part as Record<string, unknown>).text) || stringValue((part as Record<string, unknown>).content) || "" : "").filter(Boolean).join("\n"); return text || undefined; }
function pathValue(record: Record<string, unknown>): string | undefined { for (const key of ["path", "filePath", "file_path", "filename", "file"]) { const value = stringValue(record[key]); if (value && !value.startsWith("data:")) return value; } return undefined; }
function imageData(record?: Record<string, unknown>): string | undefined { if (!record) return undefined; for (const key of ["previewUrl", "preview_url", "imageUrl", "image_url", "dataUrl", "data_url", "src"]) { const value = stringValue(record[key]); if (value?.startsWith("data:image/")) return value; } const content = record.content; if (Array.isArray(content)) for (const part of content) if (part && typeof part === "object") { const value = imageData(part as Record<string, unknown>); if (value) return value; } return undefined; }
function isImagePath(path?: string) { return Boolean(path && /\.(png|jpe?g|gif|webp|avif|svg|bmp|heic)$/i.test(path)); }
function isUsefulFilePath(path: string) { return !/^https?:\/\//.test(path) && !path.endsWith("/") && !["cwd", "worktree"].includes(path); }
function isTaskRecord(record: Record<string, unknown>, type: string, parent?: Record<string, unknown>) {
  const parentType = String(parent?.type || parent?.kind || parent?.name || "").toLowerCase();
  return type.includes("task") || type.includes("turn") || type.includes("thread") || Boolean(record.objective) || Boolean(record.taskId) || Boolean(record.task_id) || (Boolean(record.step) && parentType.includes("plan")) || (Boolean(record.content || record.subject) && (parentType.includes("todo") || parentType.includes("task")));
}
function statusFrom(value: unknown): ArtifactStatus { const normalized = String(value ?? "").toLowerCase(); if (value === true || normalized === "done" || normalized === "complete" || normalized === "completed" || normalized === "success") return "completed"; if (normalized.includes("run") || normalized === "active" || normalized === "in_progress") return "running"; if (normalized.includes("fail") || normalized.includes("error")) return "failed"; if (normalized.includes("wait") || normalized.includes("pause")) return "waiting"; if (normalized.includes("pend") || normalized.includes("queue")) return "pending"; return "unknown"; }
function roleFor(type: string) { if (type === "user" || type.includes("usermessage")) return "you"; if (type === "system") return "system"; if (type.includes("plan")) return "plan"; return "agent"; }

export default AgentArtifacts;
