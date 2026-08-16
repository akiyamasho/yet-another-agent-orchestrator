"use client";

import { useMemo, useState } from "react";
import { File, FileImage, LoaderCircle, Paperclip, Send, X } from "lucide-react";
import { splitProviderThreadId } from "@/lib/providers";
import type { AgentThread } from "@/lib/types";
import styles from "./ThreadComposer.module.css";

type Attachment = { path: string; name: string; size: number; isImage: boolean };

export function ThreadComposer({ thread, cwd, onSent }: { thread: AgentThread; cwd: string; onSent?: () => void | Promise<void> }) {
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const desktop = typeof window !== "undefined" ? window.constellationDesktop : undefined;
  const providerLabel = thread.provider === "claude" ? "Claude Code" : "Codex";
  const canSend = Boolean(message.trim() || attachments.length) && !busy && Boolean(desktop) && !thread.archived;
  const attachmentSummary = useMemo(() => attachments.reduce((total, item) => total + item.size, 0), [attachments]);

  const chooseAttachments = async () => {
    if (!desktop) return;
    setError(undefined);
    try {
      const chosen = await desktop.files.selectAttachments({ cwd });
      setAttachments((current) => {
        const byPath = new Map(current.map((item) => [item.path, item]));
        chosen.forEach((item) => byPath.set(item.path, item));
        return [...byPath.values()].slice(0, 10);
      });
    } catch (cause) {
      setError(composerError(cause, thread.provider ?? "codex"));
    }
  };

  const send = async () => {
    if (!canSend || !desktop) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const { rawId } = splitProviderThreadId(thread.id);
      if (thread.provider === "claude") await desktop.claude.continueSession({ sessionId: rawId, cwd, message: message.trim(), attachments });
      else await desktop.codex.continueThread({ threadId: rawId, message: message.trim(), attachments });
      setMessage(""); setAttachments([]); setNotice(`Sent to ${providerLabel}. Live transcript updates will appear here.`);
      await onSent?.();
    } catch (cause) {
      setError(composerError(cause, thread.provider ?? "codex"));
    } finally {
      setBusy(false);
    }
  };

  return <section className={styles.composer} aria-label={`Continue ${thread.title}`}>
    {attachments.length > 0 && <div className={styles.attachments} aria-label={`${attachments.length} attached files`}>{attachments.map((item) => <span className={styles.attachment} key={item.path} title={item.path}>{item.isImage ? <FileImage size={14}/> : <File size={14}/>}<span><strong>{item.name}</strong><small>{formatBytes(item.size)}</small></span><button onClick={() => setAttachments((current) => current.filter((candidate) => candidate.path !== item.path))} aria-label={`Remove ${item.name}`}><X size={13}/></button></span>)}</div>}
    <div className={styles.inputRow}>
      <button className={styles.attachButton} onClick={() => void chooseAttachments()} disabled={!desktop || busy} aria-label="Attach files" title="Attach files"><Paperclip size={17}/></button>
      <textarea value={message} onChange={(event) => { setMessage(event.target.value); setNotice(undefined); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} rows={2} placeholder={desktop ? `Continue this ${providerLabel} ${thread.parentId ? "subagent" : "agent"}…` : "Continuation is available in the Electron app"} disabled={!desktop || thread.archived} />
      <button className={styles.sendButton} onClick={() => void send()} disabled={!canSend} aria-label={`Send to ${providerLabel}`}>{busy ? <LoaderCircle className={styles.spin} size={17}/> : <Send size={17}/>}</button>
    </div>
    <div className={styles.footer}><span>{desktop ? <><kbd>Enter</kbd> send · <kbd>Shift Enter</kbd> newline</> : "DEMO · read-only provider fixture"}</span>{attachments.length > 0 && <span>{attachments.length}/10 files · {formatBytes(attachmentSummary)}</span>}</div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} aria-live="polite">{notice}</p>}
  </section>;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function composerError(cause: unknown, provider: "codex" | "claude") {
  const raw = cause instanceof Error ? cause.message : String(cause);
  if (provider === "codex" && /already has an active writer/i.test(raw)) {
    return "This Codex task is open in another Codex window, which currently owns the live session. Continue it there, or close that task there and retry here.";
  }
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^(CodexAppServerError|ClaudeCodeError):\s*/i, "");
}

export default ThreadComposer;
