'use strict';

// Threads returned by thread/start can be absent from the state-db-backed
// inventory for a short time. Keep only exact provider records until inventory
// confirms them (or a bounded expiry removes them).
class PendingCreatedThreads {
  constructor({ ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.items = new Map();
  }

  remember(thread) {
    const id = thread && (thread.id || thread.threadId);
    if (!id || !thread || typeof thread !== 'object') return;
    this.items.set(String(id), { thread: { ...thread, id: String(id) }, expiresAt: this.now() + this.ttlMs });
  }

  remove(id) { if (id !== undefined && id !== null) this.items.delete(String(id)); }

  overlay(threads, { includePending = () => true } = {}) {
    const inventory = Array.isArray(threads) ? threads.slice() : [];
    const seen = new Set(inventory.map((thread) => String(thread?.id || thread?.threadId || '')).filter(Boolean));
    const now = this.now();
    for (const [id, entry] of this.items) {
      if (entry.expiresAt <= now) { this.items.delete(id); continue; }
      if (seen.has(id)) this.items.delete(id);
      else if (includePending(entry.thread)) inventory.push({ ...entry.thread });
    }
    return inventory;
  }

  size() { return this.items.size; }
}

module.exports = { PendingCreatedThreads };
