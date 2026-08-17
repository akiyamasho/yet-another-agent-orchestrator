"use client";

import { memo, useEffect, useMemo, useState, type ClipboardEvent } from "react";
import { File, FileImage, LoaderCircle, Paperclip, Send, Square, X } from "lucide-react";
import { splitProviderThreadId } from "@/lib/providers";
import type { AgentThread } from "@/lib/types";
import styles from "./ThreadComposer.module.css";

type Attachment = { path: string; name: string; size: number; isImage: boolean };
type ThreadComposerProps = {
  thread: AgentThread;
  cwd: string;
  onSent?: () => void | Promise<void>;
  onCancelled?: () => void | Promise<void>;
  cancelRequest?: number;
  running?: boolean;
  onRepin?: () => void;
};

function ThreadComposerView({ thread, cwd, onSent, onCancelled, cancelRequest = 0, running = false, onRepin }: ThreadComposerProps) {
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selectedModel, setSelectedModel] = useState(() => modelValue(thread));
  const desktop = typeof window !== "undefined" ? window.constellationDesktop : undefined;
  const providerLabel = thread.provider === "claude" ? "Claude Code" : "Codex";
  const modelOptions = useMemo(() => modelsFor(thread), [thread.provider, thread.model]);
  const modelSwitchLocked = running;
  const canSend = Boolean(message.trim() || attachments.length) && !busy && !pasting && Boolean(desktop) && !thread.archived;
  const attachmentSummary = useMemo(() => attachments.reduce((total, item) => total + item.size, 0), [attachments]);

  useEffect(() => {
    setSelectedModel(modelValue(thread));
  }, [thread.id, thread.model, thread.provider]);

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

  const pasteClipboardImage = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!desktop || !Array.from(event.clipboardData.items).some((item) => item.type.startsWith("image/"))) return;
    event.preventDefault();
    if (attachments.length >= 10) { setError("Remove an attachment before pasting another image (10 file limit)."); return; }
    setPasting(true); setError(undefined); setNotice("Reading clipboard image…");
    try {
      const item = Array.from(event.clipboardData.items).find((candidate) => candidate.type === "image/png");
      const file = item?.getAsFile();
      const pasted = file
        ? await (async () => {
          if (file.size > 25 * 1024 * 1024) throw new Error("The clipboard image exceeds the 25 MB attachment limit.");
          const bytes = new Uint8Array(await file.arrayBuffer());
          return desktop.files.pasteImage({ bytes, mimeType: file.type, name: "clipboard.png" });
        })()
        : await desktop.files.pasteImage();
      setAttachments((current) => current.some((item) => item.path === pasted.path) ? current : [...current, pasted].slice(0, 10));
      setNotice("Clipboard image attached.");
    } catch (cause) {
      setError(composerError(cause, thread.provider ?? "codex"));
    } finally {
      setPasting(false);
    }
  };

  const interrupt = async () => {
    if (!desktop || busy || !running) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const { rawId } = splitProviderThreadId(thread.id);
      if (thread.provider === "claude") {
        const method = (desktop.claude as typeof desktop.claude & { interruptSession?: (sessionId: string) => Promise<unknown> }).interruptSession;
        if (!method) throw new Error("Claude Code stop control is not available in this build.");
        await method(rawId);
        setNotice("Stopped Claude Code. Your draft is preserved; send it when ready.");
      } else {
        const method = (desktop.codex as typeof desktop.codex & { interruptThread?: (threadId: string) => Promise<unknown> }).interruptThread;
        if (!method) throw new Error("Codex stop control is not available in this build.");
        await method(rawId);
        setNotice("Stopped Codex. Your draft is preserved; send it when ready.");
      }
      onRepin?.();
      await onCancelled?.();
    } catch (cause) {
      setError(composerError(cause, thread.provider ?? "codex"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (cancelRequest > 0) void interrupt();
  // Escape requests are intentionally edge-triggered by the parent.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelRequest]);

  const send = async () => {
    if (!canSend || !desktop) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const { rawId } = splitProviderThreadId(thread.id);
      const wasRunning = running;
      const result = thread.provider === "claude"
        ? await desktop.claude.continueSession({ sessionId: rawId, cwd, message: message.trim(), attachments, model: selectedModel })
        : await desktop.codex.continueThread({ threadId: rawId, message: message.trim(), attachments, model: selectedModel });
      setMessage(""); setAttachments([]); setNotice(`Sent to ${providerLabel}. Live transcript updates will appear here.`);
      if (wasRunning) {
        const mode = result && typeof result === "object" && "mode" in result ? String((result as { mode?: string }).mode || "") : "";
        setNotice(thread.provider === "claude"
          ? mode === "steer" ? "Steering Claude Code with your latest message." : "Stopped the current Claude Code run; handling your latest message."
          : mode === "steer" ? "Steering Codex with your latest message." : "Codex is handling your latest message in the active turn.");
      }
      onRepin?.();
      await onSent?.();
    } catch (cause) {
      setError(composerError(cause, thread.provider ?? "codex"));
    } finally {
      setBusy(false);
    }
  };

  return <section className={styles.composer} aria-label={`Continue ${thread.title}`}>
    {attachments.length > 0 && <div className={styles.attachments} aria-label={`${attachments.length} attached files`}>{attachments.map((item) => <span className={styles.attachment} key={item.path} title={item.path}>{item.isImage ? <FileImage size={14}/> : <File size={14}/>}<span><strong>{item.name}</strong><small>{formatBytes(item.size)}</small></span><button onClick={() => setAttachments((current) => current.filter((candidate) => candidate.path !== item.path))} aria-label={`Remove ${item.name}`}><X size={13}/></button></span>)}</div>}
    <div className={`${styles.inputRow} ${running ? styles.running : ""}`}>
      <button className={styles.attachButton} onClick={() => void chooseAttachments()} disabled={!desktop || busy || pasting} aria-label="Attach files" title="Attach files"><Paperclip size={17}/></button>
      <textarea value={message} onChange={(event) => { setMessage(event.target.value); setNotice(undefined); }} onPaste={(event) => void pasteClipboardImage(event)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} rows={2} placeholder={desktop ? `Continue this ${providerLabel} ${thread.parentId ? "subagent" : "agent"}…` : "Continuation is available in the Electron app"} disabled={!desktop || thread.archived} />
      {running && <button className={styles.cancelButton} onClick={() => void interrupt()} disabled={busy || !desktop} aria-label={`Stop ${providerLabel}`} title={`Stop ${providerLabel}`}><Square size={14}/></button>}
      <button className={styles.sendButton} onClick={() => void send()} disabled={!canSend} aria-label={`Send to ${providerLabel}`}>{busy ? <LoaderCircle className={styles.spin} size={17}/> : <Send size={17}/>}</button>
    </div>
    <div className={styles.composerMeta}>
      <label className={styles.modelPicker} title={modelSwitchLocked ? "Model switching is disabled while this locally controlled run is active." : `Choose the ${providerLabel} model for the next turn`}>
        <span>MODEL</span>
        <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={modelSwitchLocked || !desktop || thread.archived} aria-label={`${providerLabel} model`}>
          {modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      {modelSwitchLocked && <span className={styles.modelLock}>Stop the run before switching models</span>}
    </div>
    <div className={styles.footer}><span>{desktop ? <>{running && <><kbd>Esc</kbd> stop · </>}<kbd>Enter</kbd> send · <kbd>Shift Enter</kbd> newline · <kbd>⌘V</kbd> image</> : "DEMO · read-only provider fixture"}</span>{pasting ? <span>Attaching clipboard image…</span> : attachments.length > 0 && <span>{attachments.length}/10 files · {formatBytes(attachmentSummary)}</span>}</div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} aria-live="polite">{notice}</p>}
  </section>;
}

export const ThreadComposer = memo(ThreadComposerView, (previous, next) =>
  previous.cwd === next.cwd
  && previous.onSent === next.onSent
  && previous.onCancelled === next.onCancelled
  && previous.onRepin === next.onRepin
  && previous.thread.id === next.thread.id
  && previous.thread.title === next.thread.title
  && previous.thread.provider === next.thread.provider
  && previous.thread.parentId === next.thread.parentId
  && previous.thread.archived === next.thread.archived
  && previous.thread.model === next.thread.model
  && previous.cancelRequest === next.cancelRequest
  && previous.running === next.running
);
ThreadComposer.displayName = "ThreadComposer";

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

const CODEX_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex"];
const CLAUDE_MODELS = ["sonnet", "opus", "haiku", "fable"];

function modelValue(thread: AgentThread) {
  const fallback = thread.provider === "claude" ? "default" : "default";
  return thread.model && thread.model !== "Codex" && thread.model !== "Claude Code" ? thread.model : fallback;
}

function modelsFor(thread: AgentThread) {
  const isClaude = thread.provider === "claude";
  const fallback = isClaude ? "default" : "default";
  const options = isClaude ? CLAUDE_MODELS : CODEX_MODELS;
  const current = modelValue(thread);
  const values = [fallback, ...(current !== fallback ? [current] : []), ...options];
  return [...new Set(values)].map((value) => ({ value, label: value === fallback ? `${isClaude ? "Claude Code" : "Codex"} default` : value }));
}

export default ThreadComposer;
