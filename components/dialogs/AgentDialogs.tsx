"use client";

import { FormEvent, useEffect, useState } from "react";
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

  useEffect(() => {
    if (thread && (mode === "edit" || mode === "subagent")) setValues({ ...defaults, title: mode === "edit" ? thread.title : "", objective: mode === "edit" ? thread.objective : "", profile: thread.profile, model: thread.model === "Codex" || thread.model === "Claude Code" ? "default" : thread.model, effort: thread.reasoningEffort, permission: thread.permission, branch: thread.branch ?? "", provider: thread.provider ?? "codex" });
    else if (mode === "agent") setValues({ ...defaults });
  }, [thread, mode]);
  if (!open || !mode) return null;

  const folder = folderId ? folders[folderId] : thread ? folders[thread.folderId] : undefined;
  const provider = (thread?.provider ?? values.provider ?? "codex") as AgentProvider;
  const set = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const close = () => { setError(""); onClose?.(); };
  const chooseFolder = async () => {
    const selected = await window.constellationDesktop?.selectDirectory();
    if (selected) setValues((current) => ({ ...current, path: selected, name: current.name || selected.split(/[\\/]/).filter(Boolean).at(-1) || "project" }));
  };
  const submit = async (event: FormEvent | React.MouseEvent) => {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      if (mode === "archive" || mode === "delete") {
        if (!thread) return;
        if (mode === "delete") await deleteThread(thread.id); else await archiveThread(thread.id, "tree");
        close(); return;
      }
      if (mode === "folder") {
        if (!values.name.trim() || !values.path.trim()) return setError("Name and path are required.");
        const result = await createFolder({ name: values.name.trim(), path: values.path.trim(), accent: values.accent, defaultPermission: values.permission as PermissionMode });
        close(); onSaved?.(result.id); return;
      }
      if (!values.title.trim() || (!values.objective.trim() && mode !== "edit")) return setError("Title and objective are required.");
      const result = mode === "edit" && thread
        ? await updateThread(thread.id, { title: values.title.trim(), profile: values.profile, model: values.model, reasoningEffort: values.effort, permission: values.permission as PermissionMode, branch: values.branch || undefined })
        : await createThread({ folderId: folder?.id ?? folderId ?? Object.keys(folders)[0], parentId: mode === "subagent" ? threadId : undefined, title: values.title.trim(), objective: values.objective.trim(), profile: values.profile, model: values.model, reasoningEffort: values.effort, permission: values.permission as PermissionMode, branch: values.branch || undefined, provider });
      close(); onSaved?.(result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const destructive = mode === "archive" || mode === "delete";
  const heading = mode === "folder" ? "Add folder" : mode === "agent" ? "Create main agent" : mode === "subagent" ? "Add subagent" : mode === "edit" ? "Edit agent" : mode === "delete" ? (provider === "claude" ? "Remove task" : "Delete task") : "Archive task";
  const warning = provider === "claude"
    ? mode === "delete" ? "Remove this Claude Code session from Constellation? Its original local Claude history remains untouched and resumable." : "Archive this Claude Code session in Constellation? Its original local Claude history remains untouched."
    : mode === "delete" ? "Permanently delete this Codex task history? This cannot be undone." : "Archive this Codex task? It will leave active views but remain recoverable through Codex.";

  return <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
    <button className={styles.close} onClick={close} aria-label="Close dialog"><X size={17}/></button>
    <p className={styles.eyebrow}>{folder ? `${folder.name} · ${folder.path}` : "Workspace"}</p><h2 id="dialog-title">{heading}</h2>
    {mode === "agent" && <div className={styles.providerRow}><span className={styles.providerLabel}>Runtime</span><div className={styles.providerOptions}><ProviderOption active={values.provider === "codex"} provider="codex" onClick={() => set("provider", "codex")} /><ProviderOption active={values.provider === "claude"} provider="claude" onClick={() => set("provider", "claude")} /></div></div>}
    {thread && mode !== "folder" && <div className={styles.providerBanner}><ProviderOption active provider={provider} locked /><span>{mode === "delete" ? (provider === "claude" ? "Remove" : "Delete") : mode === "archive" ? "Archive" : "Manage"} this provider task</span></div>}
    {destructive ? <><p className={styles.warning}>{warning}</p><label className={styles.check}><input type="checkbox" defaultChecked disabled /> Include mapped child threads</label></> : <form onSubmit={submit}><div className={styles.fields}>
      {mode === "folder" ? <><Field label="Folder name" value={values.name} onChange={(v) => set("name", v)} placeholder="e.g. marketing-site"/><div className={styles.pathPicker}><Field label="Local path" value={values.path} onChange={(v) => set("path", v)} placeholder="/Users/me/Projects/marketing-site"/>{window.constellationDesktop && <button type="button" onClick={chooseFolder}><FolderOpen size={15}/>Browse</button>}</div><Field label="Accent" value={values.accent} onChange={(v) => set("accent", v)} type="color"/><Select label="Default permission" value={values.permission} onChange={(v) => set("permission", v)} options={permissions}/></>
        : <><Field label={mode === "subagent" ? "Bounded task" : "Task title"} value={values.title} onChange={(v) => set("title", v)} placeholder="A concise task name"/><label>{mode === "edit" && window.constellationDesktop ? "Original objective · read only" : "Objective"}<textarea value={values.objective} onChange={(e) => set("objective", e.target.value)} placeholder="What should this agent deliver?" rows={3} disabled={mode === "edit" && Boolean(window.constellationDesktop)}/></label><div className={styles.grid}><Field label="Profile" value={values.profile} onChange={(v) => set("profile", v)}/><Field label="Model" value={values.model} onChange={(v) => set("model", v)}/><Select label="Reasoning" value={values.effort} onChange={(v) => set("effort", v)} options={provider === "claude" ? ["default", "low", "medium", "high", "max"] : ["default", "low", "medium", "high", "xhigh", "ultra"]}/><Select label="Permission" value={values.permission} onChange={(v) => set("permission", v)} options={permissions}/></div><Field label="Branch / worktree (optional)" value={values.branch} onChange={(v) => set("branch", v)} placeholder="agent/task-name"/></>}
    </div>{error && <p className={styles.error} role="alert">{error}</p>}<div className={styles.footer}><button type="button" onClick={close} disabled={busy}>Cancel</button><button className={styles.submit} type="submit" disabled={busy}>{busy ? "Working…" : mode === "edit" ? "Save changes" : mode === "folder" ? "Add folder" : mode === "subagent" ? "Delegate" : "Create & run"}</button></div></form>}
    {destructive && <div className={styles.footer}>{error && <p className={styles.error} role="alert">{error}</p>}<button onClick={close} disabled={busy}>Cancel</button><button className={styles.submitDanger} onClick={submit} disabled={busy}>{busy ? "Working…" : mode === "delete" ? (provider === "claude" ? "Remove from Constellation" : "Delete task") : "Archive task"}</button></div>}
  </section></div>;
}

function ProviderOption({ provider, active, onClick, locked }: { provider: AgentProvider; active?: boolean; onClick?: () => void; locked?: boolean }) { return <button type="button" className={`${styles.providerOption} ${active ? styles.providerActive : ""}`} onClick={onClick} disabled={locked} aria-pressed={active}><span className={`${styles.providerDot} ${styles[provider]}`} />{provider === "codex" ? "Codex" : "Claude Code"}{locked && <small>BOUND</small>}</button>; }
function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) { return <label>{label}<input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}/></label>; }
function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) { return <label>{label}<select value={value} onChange={(e) => onChange(e.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select></label>; }
export default AgentDialogs;
