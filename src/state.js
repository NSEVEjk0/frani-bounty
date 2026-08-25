/**
 * frani-bounty — persisted state (the on-disk escrow ledger)
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * A JSON-backed store in wallet-data/state.json holding everything the board
 * must remember to behave correctly, transparently and idempotently across
 * restarts:
 *   • seenDmIds / seenTransferIds / handledPaymentReqIds — dedup rings
 *     (relays replay; events double-fire — we act on each id at most once)
 *   • bounties            — the full record for every bounty, keyed by id
 *   • pendingTopups       — a poster's outstanding `add-reward` intent, matched
 *                           to their next incoming transfer
 *   • bookBalanceBase     — lag-free spendable corpus (see sphere-client)
 *   • sweepableBase       — accrued protocol fees + tips the owner may withdraw
 *   • blacklist           — accounts blocked from posting/claiming
 *   • ledger              — append-only event log (capped) for `history`/audit
 *   • stats               — lifetime totals
 *
 * The custodial invariant the whole design protects:  spendable ≥ Σ live escrow.
 * "Live escrow" = funds we are holding on behalf of a bounty (a draft's partial
 * funding, or an open/claimed/submitted bounty's reward). It is computed from the
 * bounties map (never a denormalised counter that could drift).
 *
 * Money is stored as base-unit DECIMAL STRINGS (BigInt isn't JSON-native) and
 * only ever parsed back through BigInt — never through Number. Writes are atomic
 * (temp file + rename, mode 0600) so a crash mid-write can't corrupt the ledger.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import config from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('state');

const RING_CAP = 500; // max ids kept per dedup ring
const LEDGER_CAP = 500; // remembered events (audit trail / history)
const STATE_VERSION = 1;

/** Bounty lifecycle states. */
export const STATUS = Object.freeze({
  DRAFT: 'draft', // created, awaiting escrow funding
  OPEN: 'open', // funded & claimable
  CLAIMED: 'claimed', // a worker is on it
  SUBMITTED: 'submitted', // proof submitted, awaiting poster confirmation
  RELEASING: 'releasing', // interim: a release send is in flight (crash-safety marker)
  REFUNDING: 'refunding', // interim: a refund send is in flight (crash-safety marker)
  RELEASED: 'released', // reward paid to claimer (terminal)
  REFUNDED: 'refunded', // reward returned to poster (terminal)
  EXPIRED: 'expired', // timed out unclaimed → refunded (terminal)
  CANCELLED: 'cancelled', // cancelled by poster/owner → refunded any funds (terminal)
});

// Statuses in which we are actively holding funds on behalf of a bounty.
const HELD_STATUSES = new Set([STATUS.DRAFT, STATUS.OPEN, STATUS.CLAIMED, STATUS.SUBMITTED]);
// Terminal statuses (no further transitions).
export const TERMINAL_STATUSES = new Set([
  STATUS.RELEASED,
  STATUS.REFUNDED,
  STATUS.EXPIRED,
  STATUS.CANCELLED,
]);

/** Normalize a pubkey to x-only lowercase hex so 02.../03… and bare forms collide. */
export function normalizeKey(key) {
  if (typeof key !== 'string') return String(key ?? '');
  const k = key.trim().toLowerCase();
  if (k.length === 66 && (k.startsWith('02') || k.startsWith('03'))) return k.slice(2);
  return k;
}

function statePath() {
  return join(resolve(config.walletDir), 'state.json');
}

function freshStats() {
  return {
    bountiesCreated: 0,
    bountiesFunded: 0,
    bountiesReleased: 0,
    bountiesRefunded: 0, // cancelled + expired refunds included
    bountiesExpired: 0,
    bountiesCancelled: 0,
    releasedBase: '0', // Σ payouts to claimers (reward − fee)
    refundedBase: '0', // Σ funds returned to posters
    feesLifetimeBase: '0', // Σ protocol fees ever earned
    tipsLifetimeBase: '0', // Σ tips ever received
    feesSweptBase: '0', // Σ earnings withdrawn to the owner
  };
}

function freshState() {
  return {
    version: STATE_VERSION,
    serviceIntentId: null,
    paused: false,
    // Lag-free "book" balance of the spendable corpus (base-unit string, or null
    // until first anchored). See sphere-client.effectiveSpendableBase().
    bookBalanceBase: null,
    // Accrued protocol fees + tips available for the owner to withdraw. Kept as a
    // running counter so the withdrawable amount is unambiguous.
    sweepableBase: '0',
    seenDmIds: [],
    seenTransferIds: [],
    handledPaymentReqIds: [],
    bounties: {}, // { [id]: Bounty }
    pendingTopups: {}, // { [normKey(poster)]: { bountyId, amountBase, at } }
    blacklist: {}, // { [normKey]: true }
    ledger: [], // append-only event log
    stats: freshStats(),
  };
}

/** Push onto a capped ring; returns true if the id was NEW (not already present). */
function ringAdd(arr, id, cap = RING_CAP) {
  if (!id) return false;
  if (arr.includes(id)) return false;
  arr.push(id);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
  return true;
}

const B = (x) => BigInt(x ?? '0');

export class State {
  constructor(data) {
    this.data = data;
  }

  static load() {
    const path = statePath();
    if (!existsSync(path)) return new State(freshState());
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      const data = { ...freshState(), ...raw };
      for (const k of ['seenDmIds', 'seenTransferIds', 'handledPaymentReqIds', 'ledger']) {
        if (!Array.isArray(data[k])) data[k] = [];
      }
      for (const k of ['bounties', 'pendingTopups', 'blacklist']) {
        if (typeof data[k] !== 'object' || data[k] === null) data[k] = {};
      }
      data.stats = { ...freshStats(), ...(data.stats ?? {}) };
      return new State(data);
    } catch (err) {
      log.warn(`state.json unreadable (${err?.message ?? err}); starting fresh.`);
      return new State(freshState());
    }
  }

  save() {
    const path = statePath();
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, path); // atomic swap
    } catch (err) {
      log.warn(`Could not persist state: ${err?.message ?? err}`);
    }
  }

  // ── dedup rings ──────────────────────────────────────────────────────────────
  markDmSeen(id) {
    return ringAdd(this.data.seenDmIds, id);
  }
  markTransferSeen(id) {
    return ringAdd(this.data.seenTransferIds, id);
  }
  markPaymentReqSeen(id) {
    return ringAdd(this.data.handledPaymentReqIds, id);
  }

  // ── operational flags ─────────────────────────────────────────────────────────
  get serviceIntentId() {
    return this.data.serviceIntentId;
  }
  setServiceIntentId(id) {
    this.data.serviceIntentId = id;
  }
  get paused() {
    return this.data.paused === true;
  }
  setPaused(v) {
    this.data.paused = !!v;
  }

  // ── book balance (lag-free spendable corpus) ─────────────────────────────────
  getBookBase() {
    return this.data.bookBalanceBase == null ? null : B(this.data.bookBalanceBase);
  }
  setBookBase(base) {
    this.data.bookBalanceBase = B(base).toString();
  }
  /**
   * Adjust the book by a signed delta (negative on release/refund/sweep,
   * positive on mint), clamped at zero. No-op while unanchored — the next
   * quiescent reconcile anchors it to the confirmed chain balance.
   */
  adjustBook(deltaBase) {
    if (this.data.bookBalanceBase == null) return;
    let v = B(this.data.bookBalanceBase) + B(deltaBase);
    if (v < 0n) v = 0n;
    this.data.bookBalanceBase = v.toString();
  }

  // ── earnings (fees + tips) available to withdraw ─────────────────────────────
  get sweepableBase() {
    return B(this.data.sweepableBase);
  }
  addSweepable(deltaBase) {
    let v = B(this.data.sweepableBase) + B(deltaBase);
    if (v < 0n) v = 0n;
    this.data.sweepableBase = v.toString();
  }

  // ── blacklist ────────────────────────────────────────────────────────────────
  isBlacklisted(pubkey) {
    return this.data.blacklist[normalizeKey(pubkey)] === true;
  }
  setBlacklist(pubkey, on) {
    const key = normalizeKey(pubkey);
    if (on) this.data.blacklist[key] = true;
    else delete this.data.blacklist[key];
  }

  // ── bounties ─────────────────────────────────────────────────────────────────
  /** Generate a short, collision-checked bounty id (6 hex chars). */
  newBountyId() {
    for (let i = 0; i < 20; i++) {
      const id = randomUUID().replace(/-/g, '').slice(0, 6);
      if (!this.data.bounties[id]) return id;
    }
    return randomUUID().replace(/-/g, '').slice(0, 10); // vanishingly unlikely fallback
  }

  putBounty(bounty) {
    this.data.bounties[bounty.id] = bounty;
    return bounty;
  }

  /** Case-insensitive lookup (ids are lowercase hex). */
  getBounty(id) {
    if (!id) return null;
    return this.data.bounties[String(id).trim().toLowerCase()] ?? null;
  }

  allBounties() {
    return Object.values(this.data.bounties);
  }

  bountiesWhere(pred) {
    return this.allBounties().filter(pred);
  }

  openBounties() {
    return this.bountiesWhere((b) => b.status === STATUS.OPEN);
  }

  bountiesByPoster(pubkey) {
    const key = normalizeKey(pubkey);
    return this.bountiesWhere((b) => b.poster === key);
  }

  bountiesByClaimer(pubkey) {
    const key = normalizeKey(pubkey);
    return this.bountiesWhere((b) => b.claimer === key);
  }

  /** A poster's drafts still awaiting (full) funding, oldest first (FIFO). */
  unfundedDraftsByPoster(pubkey) {
    const key = normalizeKey(pubkey);
    return this.bountiesWhere((b) => b.poster === key && b.status === STATUS.DRAFT).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  countOpenLikeForPoster(pubkey) {
    const key = normalizeKey(pubkey);
    return this.bountiesWhere(
      (b) => b.poster === key && HELD_STATUSES.has(b.status),
    ).length;
  }

  countActiveClaimsForClaimer(pubkey) {
    const key = normalizeKey(pubkey);
    return this.bountiesWhere(
      (b) => b.claimer === key && (b.status === STATUS.CLAIMED || b.status === STATUS.SUBMITTED),
    ).length;
  }

  // ── escrow accounting (the custodial obligation) ─────────────────────────────
  /** Funds currently held on behalf of a single bounty (base units). */
  heldBase(b) {
    if (!b) return 0n;
    if (b.status === STATUS.DRAFT) return B(b.fundedBase);
    if (HELD_STATUSES.has(b.status)) return B(b.rewardBase);
    return 0n;
  }

  /** Total live escrow across all bounties, optionally excluding one id. */
  escrowedTotalBase(excludeId = null) {
    let sum = 0n;
    for (const b of this.allBounties()) {
      if (excludeId && b.id === excludeId) continue;
      sum += this.heldBase(b);
    }
    return sum;
  }

  /**
   * Forward-looking committed total: what the board WILL hold if every
   * non-terminal bounty is funded to its full reward. Used as the (stricter)
   * global-custody-cap gate when accepting a new bounty, so many unfunded drafts
   * can't collectively over-commit the board past its custody ceiling.
   */
  committedTotalBase(excludeId = null) {
    let sum = 0n;
    for (const b of this.allBounties()) {
      if (excludeId && b.id === excludeId) continue;
      if (TERMINAL_STATUSES.has(b.status)) continue;
      sum += B(b.rewardBase);
    }
    return sum;
  }

  // ── pending add-reward top-ups ───────────────────────────────────────────────
  setPendingTopup(pubkey, bountyId, amountBase, now = Date.now()) {
    this.data.pendingTopups[normalizeKey(pubkey)] = {
      bountyId,
      amountBase: B(amountBase).toString(),
      at: now,
    };
  }
  getPendingTopup(pubkey) {
    return this.data.pendingTopups[normalizeKey(pubkey)] ?? null;
  }
  clearPendingTopup(pubkey) {
    delete this.data.pendingTopups[normalizeKey(pubkey)];
  }

  // ── ledger (audit trail) ─────────────────────────────────────────────────────
  appendLedger(entry) {
    this.data.ledger.push({ id: randomUUID(), ...entry });
    if (this.data.ledger.length > LEDGER_CAP) {
      this.data.ledger.splice(0, this.data.ledger.length - LEDGER_CAP);
    }
  }

  recentLedger(n = 12) {
    return this.data.ledger.slice(-n).reverse();
  }

  /** Recent ledger events touching a given party (as poster or claimer). */
  recentLedgerFor(pubkey, n = 12) {
    const key = normalizeKey(pubkey);
    return this.data.ledger
      .filter((e) => normalizeKey(e.poster ?? '') === key || normalizeKey(e.claimer ?? '') === key || normalizeKey(e.party ?? '') === key)
      .slice(-n)
      .reverse();
  }

  // ── stats mutations ──────────────────────────────────────────────────────────
  bumpStat(key, by = 1) {
    this.data.stats[key] = (this.data.stats[key] ?? 0) + by;
  }
  addStatBase(key, deltaBase) {
    this.data.stats[key] = (B(this.data.stats[key]) + B(deltaBase)).toString();
  }

  get stats() {
    return this.data.stats;
  }
}

export default State;
