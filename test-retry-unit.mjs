/**
 * test-retry-unit.mjs — deterministic, offline proof of the settlement-retry fix.
 *
 * Drives the REAL cancelBounty → refundBounty → sweep code paths against a fake
 * client whose guarded send returns `escrow-protect` on demand (exactly what the
 * live co-mingling guard returns while the book hasn't reconciled up to the
 * just-received escrow). No network, no timing races — pure state-machine proof.
 *
 * It asserts the whole lifecycle of the fix:
 *   1. a transiently-held cancel reverts the bounty but leaves a `settleRetry`
 *      marker (the funds are provably untouched — the fake never "sent")
 *   2. a settling bounty is hidden from `list` and refused for `claim`/`boost`
 *   3. the sweep silently re-drives the held move (no repeated party DMs)
 *   4. once the guard clears, the sweep completes the refund EXACTLY ONCE and
 *      clears the marker → terminal CANCELLED
 *   5. a further sweep is idempotent (no double-refund)
 *
 * Gitignored (test-*.mjs). Run: node test-retry-unit.mjs
 */

// Isolate config from the live .env and wallet-data: point it at a throwaway dir
// and a non-existent env file BEFORE importing anything that reads config.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'frani-bounty-retry-'));
process.env.ENV_FILE = join(tmp, 'no-such.env'); // force config to fall back to defaults
process.env.WALLET_DIR = tmp; // State reads/writes state.json here
process.env.LOG_LEVEL = 'warn';

const { STATUS, State, normalizeKey } = await import('./src/state.js');
const { cancelBounty, claimBounty, addReward, sweep, summarizeBounty } = await import('./src/bounty.js');
const { RateLimiter } = await import('./src/ratelimit.js');

const DEC = 18n;
const UCT = (n) => (BigInt(n) * 10n ** DEC).toString();
const toWhole = (base) => {
  const b = BigInt(base), D = 10n ** DEC;
  const f = (b % D).toString().padStart(Number(DEC), '0').replace(/0+$/, '');
  return f ? `${b / D}.${f}` : `${b / D}`;
};

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.log(`  ❌ ${msg}`); } };

// ── a fake client modelling the guarded send outcome directly ──────────────────
const client = {
  heldMode: true, // while true, refund/release return the escrow-protect hold
  refunds: [], // every actual (non-held) refund send, for exactly-once proof
  releases: [],
  dms: [], // every outbound DM, to prove silence-on-retry
  coin: { symbol: 'UCT', decimals: Number(DEC) },
  fmt: (base) => `${toWhole(base)} UCT`,
  toBase: (whole) => UCT(String(whole).split('.')[0]),
  toWhole,
  async sendDM(recipient, content) { this.dms.push({ recipient, content }); return { id: `dm-${this.dms.length}` }; },
  async refund(recipient, base, memo) {
    if (this.heldMode) return { skipped: 'escrow-protect' };
    this.refunds.push({ recipient, base: BigInt(base).toString(), memo });
    return { status: 'ok' };
  },
  async release(recipient, base, memo) {
    if (this.heldMode) return { skipped: 'escrow-protect' };
    this.releases.push({ recipient, base: BigInt(base).toString(), memo });
    return { status: 'ok' };
  },
};

const rl = new RateLimiter();
const state = State.load(); // fresh (no state.json in the temp dir)

// A funded, live OPEN bounty owned by the poster.
const POSTER = '02' + 'a'.repeat(64);
const WORKER = '02' + 'b'.repeat(64);
const now = Date.now();
const b = {
  id: 'ab12cd',
  status: STATUS.OPEN,
  poster: normalizeKey(POSTER),
  posterNametag: 'poster-demo',
  posterRecipient: '@poster-demo',
  claimer: null,
  claimerRecipient: null,
  title: 'Offline retry test bounty',
  rewardBase: UCT(2),
  fundedBase: UCT(2),
  feeBps: 200,
  openExpiryAt: now + 30 * 24 * 3600 * 1000,
  createdAt: now - 5000,
  updatedAt: now - 5000,
};
state.putBounty(b);
state.save();

const dm = (pub, tag) => ({ senderPubkey: pub, senderNametag: tag });

console.log('════════ frani-bounty · settlement-retry unit proof (offline) ════════');

// ── 1) Poster cancels while the guard is tripped → held, marker set, no money ──
console.log('\n[1] cancel while the co-mingling guard is tripped (escrow-protect)');
const r1 = await cancelBounty(client, state, rl, { dm: dm(POSTER, 'poster-demo'), bountyId: 'ab12cd' });
const after1 = state.getBounty('ab12cd');
ok(r1.ok === false && r1.held === true && r1.skipped === 'escrow-protect', 'cancel reports held (escrow-protect), not success');
ok(after1.status === STATUS.OPEN, 'bounty reverted to OPEN (not stuck in REFUNDING)');
ok(!!after1.settleRetry && after1.settleRetry.move === 'refund' && after1.settleRetry.kind === 'cancelled', 'settleRetry marker set: move=refund, kind=cancelled');
ok(after1.settleRetry.attempts === 1, 'settleRetry.attempts === 1');
ok(client.refunds.length === 0, 'NO refund actually sent — funds provably untouched');
ok(client.dms.length === 1 && /safe and will be returned shortly/i.test(client.dms[0].content), 'poster got exactly one "safe, returned shortly" notice');

// ── 2) a settling bounty is hidden from list and refused for claim/boost ───────
console.log('\n[2] a settling bounty is not claimable / boostable / listable');
ok(state.openBounties().length === 0, 'openBounties() excludes the settling bounty (not advertised)');
const dmCount2 = client.dms.length;
const rc = await claimBounty(client, state, rl, { dm: dm(WORKER, 'worker-demo'), bountyId: 'ab12cd' });
ok(rc.ok === false && /being settled/i.test(client.dms[client.dms.length - 1].content), 'claim is refused with a "being settled" reply');
const rb = await addReward(client, state, rl, { dm: dm(WORKER, 'worker-demo'), bountyId: 'ab12cd', amountWhole: '1' });
ok(rb.ok === false && /being settled/i.test(client.dms[client.dms.length - 1].content), 'boost is refused with a "being settled" reply');
ok(/⏳ settling/.test(summarizeBounty(client, after1)), 'summary line shows the ⏳ settling badge');

// ── 3) sweep while STILL held → silent retry, attempts increments, no money ────
console.log('\n[3] sweep while still held → silent retry (no repeated DMs, no money)');
const dmsBeforeSweep = client.dms.length;
await sweep(client, state, rl);
const after3 = state.getBounty('ab12cd');
ok(after3.status === STATUS.OPEN && !!after3.settleRetry, 'still held after a sweep (guard has not cleared)');
ok(after3.settleRetry.attempts === 2, 'settleRetry.attempts incremented to 2');
ok(after3.settleRetry.since === after1.settleRetry.since, 'settleRetry.since preserved across retries');
ok(client.refunds.length === 0, 'still no refund sent while held');
ok(client.dms.length === dmsBeforeSweep, 'retry is SILENT — no duplicate "safe, returned shortly" DM spam');

// ── 4) guard clears → next sweep completes the refund exactly once ─────────────
console.log('\n[4] guard clears → next sweep settles the refund exactly once');
client.heldMode = false;
await sweep(client, state, rl);
const after4 = state.getBounty('ab12cd');
ok(after4.status === STATUS.CANCELLED, 'bounty is now terminal CANCELLED');
ok(!after4.settleRetry, 'settleRetry marker cleared on success');
ok(client.refunds.length === 1, 'refund sent EXACTLY ONCE');
ok(client.refunds[0].recipient === '@poster-demo' && client.refunds[0].base === UCT(2), 'refund went to the poster for the full 2 UCT (no fee)');
ok(/returned to you in full/i.test(client.dms[client.dms.length - 1].content), 'poster told the refund landed in full');

// ── 5) idempotency: a further sweep must not double-refund ─────────────────────
console.log('\n[5] idempotency — a further sweep does nothing');
await sweep(client, state, rl);
ok(client.refunds.length === 1, 'still exactly one refund after another sweep (no double-pay)');
ok(state.getBounty('ab12cd').status === STATUS.CANCELLED, 'bounty stays terminal CANCELLED');

// ── 6) the RELEASE retry branch (auto-release on confirm-timeout, held) ────────
// Symmetric to refund but distinct code in the sweep (r.move === 'release').
console.log('\n[6] a held auto-RELEASE also retries and settles exactly once');
client.heldMode = true; // guard tripped again
const rel = {
  id: 'ef34gh',
  status: STATUS.SUBMITTED,
  poster: normalizeKey(POSTER),
  posterNametag: 'poster-demo',
  posterRecipient: '@poster-demo',
  claimer: normalizeKey(WORKER),
  claimerNametag: 'worker-demo',
  claimerRecipient: '@worker-demo',
  title: 'Release-retry test bounty',
  rewardBase: UCT(5),
  fundedBase: UCT(5),
  feeBps: 200,
  proof: { text: 'done', at: now },
  confirmDeadline: now - 1000, // already past → auto-release is due
  createdAt: now - 9000,
  updatedAt: now - 9000,
};
state.putBounty(rel);
state.save();

await sweep(client, state, rl); // SUBMITTED → releaseBounty(byTimeout) → held
const rel1 = state.getBounty('ef34gh');
ok(rel1.status === STATUS.SUBMITTED && !!rel1.settleRetry && rel1.settleRetry.move === 'release', 'held auto-release reverts to SUBMITTED with a release retry marker');
ok(rel1.settleRetry.byTimeout === true, 'retry carries byTimeout=true (the auto-release reason is preserved)');
ok(client.releases.length === 0, 'no reward sent while held');

client.heldMode = false;
await sweep(client, state, rl); // retry pass → release succeeds
const rel2 = state.getBounty('ef34gh');
ok(rel2.status === STATUS.RELEASED, 'bounty is now terminal RELEASED');
ok(!rel2.settleRetry, 'release settleRetry marker cleared on success');
ok(client.releases.length === 1, 'reward released EXACTLY ONCE');
const expectedPayout = BigInt(UCT(5)) - (BigInt(UCT(5)) * 200n) / 10000n; // reward − 2%
ok(client.releases[0].recipient === '@worker-demo' && BigInt(client.releases[0].base) === expectedPayout, `worker received reward − 2% fee (${toWhole(expectedPayout)} UCT)`);

await sweep(client, state, rl);
ok(client.releases.length === 1, 'still exactly one release after another sweep (no double-pay)');

console.log('\n══════════════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? '  ✅ ALL PASS — the held settlement auto-recovers via the sweep, exactly once.'
  : '  ❌ FAILURES — the retry state machine is not behaving as intended.');
console.log('══════════════════════════════════════════════════════════════════════');
process.exit(failed === 0 ? 0 : 1);
