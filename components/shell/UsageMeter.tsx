"use client";

import { useEffect, useMemo, useState } from "react";
import { Gauge } from "lucide-react";
import styles from "./UsageMeter.module.css";

type Bucket = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number | string; name?: string; [key: string]: unknown };
type UsageData = { primary?: Bucket; secondary?: Bucket; [key: string]: unknown };

function extract(value: unknown): UsageData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  // The keyed form contains every limit (primary/secondary can be only a
  // summary), so prefer it whenever the app-server supplies it.
  if (record.rateLimitsByLimitId && typeof record.rateLimitsByLimitId === "object") {
    return { rateLimitsByLimitId: record.rateLimitsByLimitId };
  }
  for (const key of ["rateLimits", "rate_limits", "data", "result"]) {
    if (record[key] && typeof record[key] === "object") {
      const nested = extract(record[key]);
      if (nested) return nested;
    }
  }
  if (record.primary || record.secondary || record.five_hour || record.weekly || record.rateLimitsByLimitId) return record as UsageData;
  return undefined;
}

function bucketList(data?: UsageData) {
  const result: Array<[string, Bucket]> = [];
  const visit = (value: unknown, path: string, seen: Set<object>) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record.usedPercent === "number") result.push([path, record as Bucket]);
    else Object.entries(record).forEach(([key, child]) => visit(child, path ? `${path}.${key}` : key, seen));
  };
  if (data) visit(data, "", new Set());
  return result;
}
function durationLabel(minutes?: number) {
  if (minutes === 300) return "5-hour";
  if (minutes === 10080) return "Weekly";
  if (!minutes || minutes <= 0) return "window duration unavailable";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}
function label(key: string, bucket: Bucket) {
  // Window duration is authoritative; key/name is only a useful qualifier for other windows.
  const duration = durationLabel(bucket.windowDurationMins);
  return duration.startsWith("window ") ? bucket.name || key.split(".").pop()?.replace(/[_-]/g, " ") || duration : duration;
}
function resetText(value: Bucket["resetsAt"]) {
  if (value === undefined || value === null) return "reset time unavailable";
  const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? "reset time unavailable" : `resets ${date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

export function UsageMeter() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<UsageData>();
  const [available, setAvailable] = useState(true);
  const desktop = typeof window !== "undefined" ? window.constellationDesktop : undefined;
  useEffect(() => {
    if (!desktop) { setAvailable(false); return; }
    let active = true;
    void desktop.codex.getRateLimits().then((result) => { if (active) { setAvailable(result.available); setData(extract(result.data)); } }).catch(() => { if (active) setAvailable(false); });
    const remove = desktop.codex.onNotification((message) => {
      if (message.method !== "account/rateLimits/updated") return;
      setAvailable(true); setData(extract(message.params));
    });
    return () => { active = false; remove(); };
  }, [desktop]);
  const buckets = useMemo(() => bucketList(data), [data]);
  const primary = buckets.find(([, bucket]) => bucket.windowDurationMins === 300)?.[1];
  const remaining = primary && typeof primary.usedPercent === "number" ? Math.max(0, Math.min(100, 100 - primary.usedPercent)) : undefined;
  return <div className={styles.wrap}>
    <button type="button" className={styles.meter} onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="dialog" aria-label="View provider usage remaining"><Gauge size={13} /><span>Usage remaining</span><b>{remaining === undefined ? "—" : `${Math.round(remaining)}%`}</b></button>
    {open && <div className={styles.popover} role="dialog" aria-label="Provider usage remaining"><div className={styles.popoverHead}><strong>Usage remaining</strong><button type="button" onClick={() => setOpen(false)} aria-label="Close usage details">×</button></div><section><h3><i className={styles.codexDot} />Codex</h3>{!desktop ? <p>DEMO · live usage unavailable</p> : !available ? <p>Live account usage is unavailable. Sign in to Codex to monitor limits.</p> : buckets.length ? buckets.map(([key, bucket]) => { const used = typeof bucket.usedPercent === "number" ? Math.max(0, Math.min(100, bucket.usedPercent)) : undefined; const bucketLabel = label(key, bucket); return <div className={styles.bucket} key={key}><div><span>{bucketLabel}</span><b>{used === undefined ? "—" : `${Math.round(100 - used)}% remaining`}</b></div><progress max="100" value={used ?? 0} aria-label={`${bucketLabel} usage`} /><small>{resetText(bucket.resetsAt)} · {bucket.windowDurationMins ? `${bucket.windowDurationMins} min window` : "duration unavailable"}</small></div>; }) : <p>Usage details are not currently exposed by Codex.</p>}</section><section><h3><i className={styles.claudeDot} />Claude Code</h3><p>{desktop ? "Live account quota is not exposed by Claude Code’s supported local provider or CLI." : "DEMO · live account quota unavailable"}</p></section></div>}
  </div>;
}
