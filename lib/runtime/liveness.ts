import type { AgentEvent, AgentThread } from "@/lib/types";

export type LivenessState = "active" | "quiet" | "possibly_stalled" | "unknown";
export type Liveness = { state: LivenessState; lastActivityAt?: string; quietMs?: number; label: string };

const ACTIVE_MS = 5 * 60_000;
const STALLED_MS = 15 * 60_000;

function timestamp(value: unknown): number {
  if (typeof value !== "string" || !value.trim()) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function candidateValues(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const direct = [record.updatedAt, record.updated_at, record.timestamp, record.createdAt, record.startedAt];
  const nested = [record.items, record.events, record.timeline].flatMap((item) => Array.isArray(item) ? item.flatMap(candidateValues) : candidateValues(item));
  return [...direct.filter((item): item is string => typeof item === "string"), ...nested];
}

export function latestActivityTimestamp(input: { thread?: Partial<AgentThread>; events?: Array<Partial<AgentEvent>>; timeline?: unknown }): string | undefined {
  const values = [
    ...candidateValues(input.thread),
    ...(input.events ?? []).flatMap(candidateValues),
    ...candidateValues(input.timeline),
  ];
  const valid = values.map((value) => ({ value, time: timestamp(value) })).filter((item) => Number.isFinite(item.time));
  return valid.sort((a, b) => b.time - a.time)[0]?.value;
}

export function formatQuietDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return "under 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export function formatLivenessNotice(liveness: Liveness): string {
  if (liveness.state === "quiet" && liveness.quietMs !== undefined) return `No new activity for ${formatQuietDuration(liveness.quietMs)} · quiet`;
  if (liveness.state === "possibly_stalled" && liveness.quietMs !== undefined) return `No new activity for ${formatQuietDuration(liveness.quietMs)} · possibly stalled`;
  return liveness.label;
}

export function classifyLiveness(input: { status: AgentThread["status"] | string; thread?: Partial<AgentThread>; events?: Array<Partial<AgentEvent>>; timeline?: unknown; now?: number }): Liveness {
  if (input.status !== "running") return { state: "unknown", label: "" };
  const lastActivityAt = latestActivityTimestamp({ thread: input.thread, events: input.events, timeline: input.timeline });
  if (!lastActivityAt) return { state: "unknown", label: "Running · no timestamp" };
  const last = timestamp(lastActivityAt);
  const quietMs = Math.max(0, (input.now ?? Date.now()) - last);
  if (quietMs < ACTIVE_MS) return { state: "active", lastActivityAt, quietMs, label: "Running" };
  const duration = formatQuietDuration(quietMs);
  if (quietMs < STALLED_MS) return { state: "quiet", lastActivityAt, quietMs, label: `${duration} quiet` };
  return { state: "possibly_stalled", lastActivityAt, quietMs, label: `${duration} quiet · possibly stalled` };
}

export const LIVENESS_THRESHOLDS = { activeMs: ACTIVE_MS, stalledMs: STALLED_MS } as const;
