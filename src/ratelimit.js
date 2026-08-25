/**
 * frani-bounty — sliding-window rate limiter
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Dead-simple in-memory limiter: per named bucket we keep the timestamps of
 * recent events and prune anything older than the window. No timers, no deps —
 * pruning happens lazily on each check, so it costs nothing while idle.
 *
 * Used ONLY for politeness / anti-spam (DMs and actions per hour) — never as a
 * money control. Custody and outflow limits (per-bounty escrow, global custody
 * cap, the co-mingling guard, release rate) are enforced with exact BigInt math
 * and persisted records so they survive restarts. This limiter is purely a
 * relay-abuse guard.
 */

const HOUR_MS = 60 * 60 * 1000;

export class RateLimiter {
  constructor() {
    /** @type {Map<string, number[]>} */
    this.buckets = new Map();
  }

  _prune(name, windowMs, now) {
    const arr = this.buckets.get(name);
    if (!arr) return [];
    const cutoff = now - windowMs;
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    if (i > 0) arr.splice(0, i);
    return arr;
  }

  /** Would an event fit under `max` in the window right now? (does not consume) */
  peek(name, max, windowMs = HOUR_MS) {
    const arr = this._prune(name, windowMs, Date.now());
    return arr.length < max;
  }

  /** Try to consume one slot. Returns true if allowed (and records it), else false. */
  allow(name, max, windowMs = HOUR_MS) {
    const now = Date.now();
    const arr = this._prune(name, windowMs, now);
    if (arr.length >= max) return false;
    arr.push(now);
    this.buckets.set(name, arr);
    return true;
  }

  /** Record an event unconditionally (for high-priority actions that bypass caps). */
  record(name) {
    const arr = this.buckets.get(name) ?? [];
    arr.push(Date.now());
    this.buckets.set(name, arr);
  }

  count(name, windowMs = HOUR_MS) {
    return this._prune(name, windowMs, Date.now()).length;
  }
}

export default RateLimiter;
