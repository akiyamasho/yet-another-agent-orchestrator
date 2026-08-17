import assert from "node:assert/strict";
import test from "node:test";
import { classifyLiveness, formatLivenessNotice, formatQuietDuration, latestActivityTimestamp } from "./liveness.ts";

const now = Date.parse("2026-08-17T12:00:00.000Z");

test("classifies running work by the latest event timestamp", () => {
  const thread = { status: "running" as const, updatedAt: "2026-08-17T11:00:00.000Z", startedAt: "2026-08-17T10:00:00.000Z" };
  const events = [{ timestamp: "2026-08-17T11:58:00.000Z" }];
  assert.equal(latestActivityTimestamp({ thread, events }), "2026-08-17T11:58:00.000Z");
  assert.equal(classifyLiveness({ status: "running", thread, events, now }).state, "active");
});

test("distinguishes quiet and possibly stalled workers", () => {
  const thread = { status: "running" as const, updatedAt: "2026-08-17T11:52:00.000Z" };
  assert.equal(classifyLiveness({ status: "running", thread, now }).state, "quiet");
  assert.equal(classifyLiveness({ status: "running", thread: { ...thread, updatedAt: "2026-08-17T11:20:00.000Z" }, now }).state, "possibly_stalled");
  assert.equal(formatQuietDuration(72 * 60_000), "1h 12m");
  assert.equal(formatLivenessNotice({ state: "possibly_stalled", quietMs: 58 * 60_000, label: "58m quiet · possibly stalled" }), "No new activity for 58m · possibly stalled");
});

test("never infers liveness for a non-running status or missing timestamps", () => {
  assert.equal(classifyLiveness({ status: "completed", now }).state, "unknown");
  assert.equal(classifyLiveness({ status: "running", thread: { status: "running" }, now }).state, "unknown");
});
