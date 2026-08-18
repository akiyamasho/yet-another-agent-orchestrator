"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { useConstellationStore } from "@/lib/store/useConstellationStore";
import type { AgentProvider, PermissionMode } from "@/lib/types";
import styles from "./AgentDialogs.module.css";

export type AgentDialogMode = "folder" | "agent" | "subagent" | "edit" | "archive" | "delete";
export interface AgentDialogsProps { mode?: AgentDialogMode; open?: boolean; onClose?: () => void; folderId?: string; threadId?: string; onSaved?: (id: string) => void; }
const permissions: PermissionMode[] = ["read-only", "workspace-write", "full-access"];
const defaults = { name: "", path: "", accent: "#e2b84b", title: "", objective: "", profile: "builder", model: "default", effort: "medium", permission: "workspace-write", branch: "", provider: "codex" };

export function AgentDialogs({ mode, open = Boolean(mode), onClose, folderId, threadId, onSaved }: AgentDialogsProps) {
  const folders = useConstellationStore((s) => s.folders);
  const threads = useConstellationStore((s) => s.threads);
  const createFolder = useConstellationStore((s) => s.createFolder);
  const createThread = useConstellationStore((s) => s.createThread);
  const updateThread = useConstellationStore((s) => s.updateThread);
  const archiveThread = useConstellationStore((s) => s.archiveThread);
  const deleteThread = useConstellationStore((s) => s.deleteThread);
  const thread = threadId ? threads[threadId] : undefined;
  const [values, setValues] = useState<Record<string, string>>(defaults);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [permanent, setPermanent] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof deleteThread>>>(undefined);

  useEffect(() => {
    if (thread && (mode === "edit" || mode === "subagent")) setValues({ ...defaults, title: mode === "edit" ? thread.title : "", objective: mode === "edit" ? thread.objective : "", profile: thread.profile, model: thread.model === "Codex" || thread.model === "Claude Code" ? "default" : thread.model, effort: thread.reasoningEffort, permission: thread.permission, branch: thread.branch ?? "", provider: thread.provider ?? "codex" });
    else if (mode === "agent") setValues({ ...defaults });
  }, [thread, mode]);
  // Keyed on the threadId prop (not the derived thread) because the thread disappears
  // from the store after the post-delete syncFromSource(), which would otherwise wipe
  // the just-set result before the user sees it.
  useEffect(() => { setPermanent(false); setResult(undefined); }, [threadId]);
  const folder = folderId ? folders[folderId] : thread ? folders[thread.folderId] : undefined;
  const provider = (thread?.provider ?? values.provider ?? "codex") as AgentProvider;
  const descendantIds = useMemo(() => {
    if (!thread) return [] as string[];
    const descendants = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      Object.values(threads).forEach((candidate) => {
        if (candidate.parentId && (candidate.parentId === thread.id || descendants.has(candidate.parentId)) && !descendants.has(candidate.id)) {
          descendants.add(candidate.id);
          changed = true;
        }
      });
    }
    return [...descendants];
  }, [thread, threads]);
  if (!open || !mode) return null;
  const set = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const close = () => { setError(""); setConfirmation(""); setPermanent(false); setResult(undefined); onClose?.(); };
  const chooseFolder = async () => {
    const selected = await window.constellationDesktop?.selectDirectory();
    if (selected) setValues((current) => ({ ...current, path: selected, name: current.name || selected.split(/[\\/]/).filter(Boolean).at(-1) || "project" }));
  };
  const submit = async (event: FormEvent | React.MouseEvent) => {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      if (mode === "archive" || mode === "delete") {
        if (!thread) return;
        if (mode === "delete" && confirmation !== "DELETE") {
          setError("Type DELETE exactly to permanently delete this context.");
          return;
        }
        if (mode === "delete") {
          if (provider === "claude") {
            const summary = await deleteThread(thread.id, { permanent });
            setResult(summary);
            return;
          }
          await deleteThread(thread.id);
        } else await archiveThread(thread.id, "tree");
        close(); return;
      }
      if (mode === "folder") {
        if (!values.name.trim() || !values.path.trim()) return setError("Name and path are required.");
        const result = await createFolder({ name: values.name.trim(), path: values.path.trim(), accent: values.accent, defaultPermission: values.permission as PermissionMode });
        close(); onSaved?.(result.id); return;
      }
      if (!values.title.trim() || (!values.objective.trim() && mode !== "edit" && mode !== "agent")) return setError(mode === "agent" ? "A title is required." : "Title and objective are required.");
      const result = mode === "edit" && thread
        ? await updateThread(thread.id, { title: values.title.trim(), profile: values.profile, model: values.model, reasoningEffort: values.effort, permission: values.permission as PermissionMode, branch: values.branch || undefined })
        : await createThread({ folderId: folder?.id ?? folderId ?? "", parentId: mode === "subagent" ? threadId : undefined, title: values.title.trim(), objective: mode === "agent" ? "" : values.objective.trim(), profile: values.profile, model: values.model, reasoningEffort: values.effort, permission: values.permission as PermissionMode, branch: values.branch || undefined, provider: mode === "agent" ? "codex" : provider });
      close(); onSaved?.(result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const destructive = mode === "archive" || mode === "delete";
  const heading = mode === "folder" ? "Add folder" : mode === "agent" ? "Create main agent" : mode === "subagent" ? "Add subagent" : mode === "edit" ? "Edit task" : mode === "delete" ? "Delete permanently" : "Archive task";
  const warning = provider === "claude"
    ? mode === "delete" ? `Permanently delete this Claude Code context and ${descendantIds.length} mapped child context${descendantIds.length === 1 ? "" : "s"}? Because Claude Code has no provider delete API, Constellation will delete only the canonical discovered local transcript JSONL file${descendantIds.length === 0 ? "" : "s"} for this context and its mapped descendants. It will not touch project files, memories, settings, credentials, or unrelated caches. Stop active agents first. ${permanent ? "This cannot be undone." : "The transcript files move to the Trash, so you can restore them until you empty it."}` : "Archive this Claude Code session in Constellation? Its original local Claude history remains untouched."
    : mode === "delete" ? `Permanently delete this Codex context and ${descendantIds.length} mapped child context${descendantIds.length === 1 ? "" : "s"}? The official provider deletion removes the persisted context and spawned descendants. Stop active agents first. This cannot be undone.` : "Archive this Codex task? It will leave active views but remain recoverable through Codex.";

  return <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
    <button className={styles.close} onClick={close} aria-label="Close dialog"><X size={17}/></button>
    <p className={styles.eyebrow}>{folder ? `${folder.name} · ${folder.path}` : "Workspace"}</p><h2 id="dialog-title">{heading}</h2>
    {mode === "agent" && <p className={styles.agentHint}>This agent will open in the selected folder. Send the first instruction from Chat.</p>}
    {thread && mode !== "folder" && <div className={styles.providerBanner}><ProviderOption active provider={provider} locked /><span>{mode === "delete" ? "Delete permanently" : mode === "archive" ? "Archive" : "Manage"} this provider task</span></div>}
    {destructive ? (result ? <div className={styles.warning}>{result.deletedPathsCount === 0 ? <p>No transcript files were present to delete</p> : <><p>Freed {formatBytes(result.bytesFreed)}</p><p>{result.deletedPathsCount} transcript file{result.deletedPathsCount === 1 ? "" : "s"} {result.permanent ? "deleted permanently" : "moved to the Trash"}</p></>}</div> : <><p className={styles.warning}>{warning}</p><label className={styles.check}><input type="checkbox" defaultChecked disabled /> Include {descendantIds.length} mapped child context{descendantIds.length === 1 ? "" : "s"} {mode === "delete" ? "(required for this deletion)" : "(archive as a tree)"}</label>{provider === "claude" && mode === "delete" && <label className={styles.check}><input type="checkbox" checked={permanent} onChange={(event) => setPermanent(event.target.checked)} /> Delete permanently instead of moving to Trash</label>}{mode === "delete" && <label className={styles.confirmation}>Type <strong>DELETE</strong> to confirm<input value={confirmation} onChange={(event) => { setConfirmation(event.target.value); setError(""); }} placeholder="DELETE" autoComplete="off" spellCheck={false} /></label>}</>) : <form onSubmit={submit}><div className={styles.fields}>
      {mode === "folder" ? <><Field label="Folder name" value={values.name} onChange={(v) => set("name", v)} placeholder="e.g. marketing-site"/><div className={styles.pathPicker}><Field label="Local path" value={values.path} onChange={(v) => set("path", v)} placeholder="/Users/me/Projects/marketing-site"/>{window.constellationDesktop && <button type="button" onClick={chooseFolder}><FolderOpen size={15}/>Browse</button>}</div><Field label="Accent" value={values.accent} onChange={(v) => set("accent", v)} type="color"/><Select label="Default permission" value={values.permission} onChange={(v) => set("permission", v)} options={permissions}/></>
        : mode === "agent" ? <Field label="Agent title" value={values.title} onChange={(v) => set("title", v)} placeholder="A concise task name"/>
        : <><Field label={mode === "subagent" ? "Bounded task" : "Task title"} value={values.title} onChange={(v) => set("title", v)} placeholder="A concise task name"/><label>{mode === "edit" && window.constellationDesktop ? "Original objective · read only" : "Objective"}<textarea value={values.objective} onChange={(e) => set("objective", e.target.value)} placeholder="What should this agent deliver?" rows={3} disabled={mode === "edit" && Boolean(window.constellationDesktop)}/></label><div className={styles.grid}><Field label="Profile" value={values.profile} onChange={(v) => set("profile", v)}/><Field label="Model" value={values.model} onChange={(v) => set("model", v)}/><Select label="Reasoning" value={values.effort} onChange={(v) => set("effort", v)} options={provider === "claude" ? ["default", "low", "medium", "high", "max"] : ["default", "low", "medium", "high", "xhigh", "ultra"]}/><Select label="Permission" value={values.permission} onChange={(v) => set("permission", v)} options={permissions}/></div><Field label="Branch / worktree (optional)" value={values.branch} onChange={(v) => set("branch", v)} placeholder="agent/task-name"/></>}
    </div>{error && <p className={styles.error} role="alert">{error}</p>}<div className={styles.footer}><button type="button" onClick={close} disabled={busy}>Cancel</button><button className={styles.submit} type="submit" disabled={busy || (mode === "agent" && !folder)}>{busy ? "Working…" : mode === "edit" ? "Save changes" : mode === "folder" ? "Add folder" : mode === "subagent" ? "Delegate" : "Create agent"}</button></div></form>}
    {destructive && <div className={styles.footer}>{error && <p className={styles.error} role="alert">{error}</p>}{result ? <button className={styles.submit} onClick={close}>Done</button> : <><button onClick={close} disabled={busy}>Cancel</button><button className={styles.submitDanger} onClick={submit} disabled={busy || (mode === "delete" && confirmation !== "DELETE")}>{busy ? "Working…" : mode === "delete" ? (provider === "claude" ? (permanent ? "Delete permanently" : "Move files to Trash") : "Delete permanently") : "Archive task"}</button></>}</div>}
  </section></div>;
}

function ProviderOption({ provider, active, onClick, locked }: { provider: AgentProvider; active?: boolean; onClick?: () => void; locked?: boolean }) { return <button type="button" className={`${styles.providerOption} ${active ? styles.providerActive : ""}`} onClick={onClick} disabled={locked} aria-pressed={active}><span className={`${styles.providerDot} ${styles[provider]}`} />{provider === "codex" ? "Codex" : "Claude Code"}{locked && <small>BOUND</small>}</button>; }
function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) { return <label>{label}<input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}/></label>; }
function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) { return <label>{label}<select value={value} onChange={(e) => onChange(e.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select></label>; }
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
export default AgentDialogs;
