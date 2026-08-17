"use client";

import { useEffect, useState } from "react";
import { Check, Download, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import styles from "./SettingsPanel.module.css";

type UpdateState = {
  phase: "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "error";
  currentVersion: string;
  latestVersion?: string;
  releaseNotes?: string;
  progress?: number;
  error?: string;
  isPackaged?: boolean;
};

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [update, setUpdate] = useState<UpdateState>({ phase: "idle", currentVersion: "0.4.1" });
  const [scale, setScale] = useState(1);
  const desktop = typeof window !== "undefined" ? window.constellationDesktop : undefined;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    if (desktop) {
      void desktop.updates.getState().then(setUpdate);
      void desktop.appearance.getScale().then(setScale);
      const remove = desktop.updates.onStatus(setUpdate);
      return () => { window.removeEventListener("keydown", onKey); remove(); };
    }
    return () => window.removeEventListener("keydown", onKey);
  }, [desktop, onClose, open]);

  if (!open) return null;
  const invoke = async (action: "check" | "download" | "install") => {
    if (!desktop) return;
    try { setUpdate(await desktop.updates[action]()); }
    catch (cause) { setUpdate((current) => ({ ...current, phase: "error", error: cause instanceof Error ? cause.message : String(cause) })); }
  };

  return <div className={styles.scrim} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header><div><p>CONSTELLATION / PREFERENCES</p><h2 id="settings-title">Settings</h2></div><button onClick={onClose} aria-label="Close settings"><X size={18}/></button></header>
      <section className={styles.section}>
        <div className={styles.sectionHeading}><div><h3>Interface scale</h3><p>Increase text and controls without changing map zoom.</p></div><span>{Math.round(scale * 100)}%</span></div>
        <div className={styles.scaleOptions}>{[1, 1.1, 1.2].map((value) => <button key={value} className={scale === value ? styles.active : ""} onClick={async () => { if (desktop) setScale(await desktop.appearance.setScale(value)); else { setScale(value); document.documentElement.style.zoom = String(value); } }}>{Math.round(value * 100)}%</button>)}</div>
      </section>
      <section className={styles.section}>
        <div className={styles.sectionHeading}><div><h3>Software updates</h3><p>GitHub Releases · Apple Silicon</p></div><span>v{update.currentVersion}</span></div>
        <UpdateBody state={update} packaged={Boolean(desktop && update.isPackaged)} onCheck={() => void invoke("check")} onDownload={() => void invoke("download")} onInstall={() => void invoke("install")} onOpen={() => void desktop?.updates.openRelease()} />
      </section>
      <footer><ShieldCheck size={15}/><p>Community builds verify the published SHA-256 before replacement. They remain unsigned and are not Apple-notarized.</p></footer>
    </section>
  </div>;
}

function UpdateBody({ state, packaged, onCheck, onDownload, onInstall, onOpen }: { state: UpdateState; packaged: boolean; onCheck: () => void; onDownload: () => void; onInstall: () => void; onOpen: () => void }) {
  if (!packaged) return <div className={styles.updateCard}><p>Update installation is tested only from a packaged app in Applications.</p><button onClick={onOpen}><ExternalLink size={14}/>Open releases</button></div>;
  if (state.phase === "checking") return <div className={styles.updateCard}><LoaderCircle className={styles.spin} size={17}/><p>Checking GitHub Releases…</p></div>;
  if (state.phase === "downloading") return <div className={styles.updateCard}><Download size={17}/><div className={styles.progressCopy}><strong>Downloading and verifying v{state.latestVersion}</strong><progress max={100} value={state.progress || 0}/><small>{state.progress || 0}%</small></div></div>;
  if (state.phase === "ready") return <div className={styles.updateCard}><ShieldCheck size={17}/><div><strong>v{state.latestVersion} is downloaded and verified</strong><p>Constellation will close, replace itself, and relaunch.</p><button className={styles.primary} onClick={onInstall}>Install and relaunch</button></div></div>;
  if (state.phase === "installing") return <div className={styles.updateCard}><LoaderCircle className={styles.spin} size={17}/><p>Installing update and relaunching…</p></div>;
  if (state.phase === "available") return <div className={styles.updateCard}><Download size={17}/><div><strong>v{state.latestVersion} is available</strong>{state.releaseNotes && <p className={styles.notes}>{state.releaseNotes}</p>}<div className={styles.buttons}><button className={styles.primary} onClick={onDownload}>Download update</button><button onClick={onOpen}><ExternalLink size={14}/>Release notes</button></div></div></div>;
  if (state.phase === "current") return <div className={styles.updateCard}><Check size={17}/><div><strong>Constellation is up to date</strong><p>Latest release: v{state.latestVersion || state.currentVersion}</p><button onClick={onCheck}><RefreshCw size={14}/>Check again</button></div></div>;
  if (state.phase === "error") return <div className={`${styles.updateCard} ${styles.updateError}`}><div><strong>Update could not be completed</strong><p>{state.error}</p><div className={styles.buttons}><button onClick={onCheck}>Try again</button><button onClick={onOpen}><ExternalLink size={14}/>Download manually</button></div></div></div>;
  return <div className={styles.updateCard}><RefreshCw size={17}/><div><strong>Check for a newer release</strong><p>Constellation checks only when you ask.</p><button className={styles.primary} onClick={onCheck}>Check for updates</button></div></div>;
}

export default SettingsPanel;
