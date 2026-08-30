/**
 * test-silent-close-unit.mjs — offline proof that a bounty which closes with
 * NOTHING in escrow still tells the poster it closed.
 *
 * `refundBounty`'s zero-balance branch used to set the terminal status, record the
 * event and return `{ok:true, nothing:true}` without sending a single DM. Two ways in,
 * both bad:
 *
 *   `cancel <unfunded-draft>`  — a direct instruction answered with nothing at all
 *   a funding window elapsing  — silence *after* the board had already sent
 *                                "fund #id before <when> or it expires"
 *
 * The second is the worse one: the board promises the outcome, then goes quiet at the
 * exact moment the warned-of thing happens. The sibling desk (@frani-agora) had the
 * identical defect in its own refundDeal; this is the same class, found by auditing
 * every terminal transition for "did anyone actually tell the counterparty?".
 *
 * No network, no wallet, no funds: drives the real cancelBounty/sweep code paths
 * against the same style of fake client as test-retry-unit.mjs.
 *
 * Gitignored (test-*.mjs). Run: node test-silent-close-unit.mjs
 */

// Isolate config from the live .env and wallet-data BEFORE importing anything
// that reads config (identical preamble to test-retry-unit.mjs, same reasons).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'frani-bounty-silent-'));
process.env.ENV_FILE = join(tmp, 'no-such.env');
process.env.WALLET_DIR = tmp;
process.env.LOG_LEVEL = 'error'; // the fix logs at info; keep the output readable

const { STATUS, State, normalizeKey } = await import('./src/state.js');
const { cancelBounty, sweep } = await import('./src/bounty.js');
const { RateLimiter } = await import('./src/ratelimit.js');
const { default: config } = await import('./src/config.js');

const DEC = 18n;
const UCT = (n) => (BigInt(n) * 10n ** DEC).toString();
const toWhole = (base) => {
  const b = BigInt(base), D = 10n ** DEC;
  const f = (b % D).toString().padStart(Number(DEC), '0').replace(/0+$/, '');
  return f ? `${b / D}.${f}` : `${b / D}`;
};

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.log(`  ❌ ${msg}`); } };

/** A fake client that records DMs and would record any money move. */
const makeClient = () => ({
  refunds: [],
  releases: [],
  dms: [],
  coin: { symbol: 'UCT', decimals: Number(DEC) },
  fmt: (base) => `${toWhole(base)} UCT`,
  toBase: (whole) => UCT(String(whole).split('.')[0]),
  toWhole,
  async sendDM(recipient, content) { this.dms.push({ recipient, content }); return { id: `dm-${this.dms.length}` }; },
  async refund(recipient, base, memo) { this.refunds.push({ recipient, base: BigInt(base).toString(), memo }); return { status: 'ok' }; },
  async release(recipient, base, memo) { this.releases.push({ recipient, base: BigInt(base).toString(), memo }); return { status: 'ok' }; },
});

const POSTER = '02' + 'a'.repeat(64);
const dm = (pub, tag) => ({ senderPubkey: pub, senderNametag: tag });
const HOUR_MS = 3600_000;

/** An UNFUNDED draft — reward named, nothing ever sent into escrow. */
const draft = (id, now) => ({
  id,
  status: STATUS.DRAFT,
  poster: normalizeKey(POSTER),
  posterNametag: 'poster-demo',
  posterRecipient: '@poster-demo',
  claimer: null,
  claimerRecipient: null,
  title: 'Never funded',
  rewardBase: UCT(2),
  fundedBase: '0', // ← the whole point: escrow is empty
  feeBps: 200,
  fundDeadline: now + config.bounty.fundWindowHours * HOUR_MS,
  createdAt: now - 5000,
  updatedAt: now - 5000,
});

const freshState = () => {
  const s = State.load();
  for (const b of s.allBounties?.() ?? []) s.deleteBounty?.(b.id);
  return s;
};

console.log('════════ frani-bounty · silent-close unit proof (offline) ════════');

// ── 1) cancel an unfunded draft ───────────────────────────────────────────────
console.log('\n[1] `cancel` on an UNFUNDED draft is acknowledged, not closed in silence');
{
  const client = makeClient();
  const state = freshState();
  const rl = new RateLimiter();
  const now = Date.now();
  state.putBounty(draft('aa11bb', now));
  state.save();

  const r = await cancelBounty(client, state, rl, { dm: dm(POSTER, 'poster-demo'), bountyId: 'aa11bb' });
  const after = state.getBounty('aa11bb');

  ok(r.ok === true && r.nothing === true, 'the close reports ok with nothing held');
  ok(after.status === STATUS.CANCELLED, 'terminal status is CANCELLED');
  ok(client.refunds.length === 0, 'no refund sent — nothing was ever in escrow');
  ok(client.dms.length === 1, `exactly one acknowledgement — no flood, no silence (got ${client.dms.length})`);
  const body = client.dms[0]?.content ?? '';
  ok(body.includes('aa11bb'), 'it names the bounty');
  ok(/cancelled/i.test(body), 'it says cancelled');
  ok(/nothing to refund|we're square/i.test(body), 'it says there is nothing to refund');
}

// ── 2) a funding window that elapses ──────────────────────────────────────────
console.log('\n[2] a funding window elapsing on an UNFUNDED draft is reported');
{
  const client = makeClient();
  const state = freshState();
  const rl = new RateLimiter();
  const now = Date.now();
  state.putBounty(draft('cc22dd', now));
  state.save();

  // Well past the deadline, and past the "fund soon" reminder window too — this is
  // the case where the poster HAS been warned and then heard nothing.
  const later = now + (config.bounty.fundWindowHours + 1) * HOUR_MS;
  const s = await sweep(client, state, rl, later);
  const after = state.getBounty('cc22dd');

  ok(after.status === STATUS.EXPIRED, 'terminal status is EXPIRED');
  ok(s.expired >= 1, `the sweep counted it expired (got ${s.expired})`);
  ok(client.refunds.length === 0, 'no refund sent — nothing was ever in escrow');
  const bodies = client.dms.map((m) => m.content);
  ok(bodies.some((b) => b.includes('cc22dd') && /expired/i.test(b)), 'the poster is told it expired');
  ok(bodies.some((b) => /nothing to return|nothing had been funded/i.test(b)),
    'and told there is nothing to return');
}

// ── 3) the money path is untouched ────────────────────────────────────────────
console.log('\n[3] a PARTLY funded draft still takes the money path, not the new one');
{
  // The risk in this change is over-reach: making the nothing-held branch talk must not
  // let it swallow a case where escrow is non-empty. `state.heldBase` is what decides,
  // and it is worth knowing why the boundary sits where it does — for a DRAFT it returns
  // `fundedBase` (whatever actually arrived), and for every held status it returns
  // `rewardBase`, because a bounty only goes OPEN once it is fully funded. So the
  // nothing-held branch is reachable from a DRAFT alone, and only an unfunded one.
  const client = makeClient();
  const state = freshState();
  const rl = new RateLimiter();
  const now = Date.now();
  const b = draft('ee33ff', now);
  b.fundedBase = UCT(1); // 1 of the 2 UCT reward arrived, then the poster changed their mind
  state.putBounty(b);
  state.save();

  const r = await cancelBounty(client, state, rl, { dm: dm(POSTER, 'poster-demo'), bountyId: 'ee33ff' });
  const after = state.getBounty('ee33ff');

  ok(r.nothing !== true, 'not reported as a nothing-held close');
  ok(after.status === STATUS.CANCELLED, 'terminal status is CANCELLED');
  ok(client.refunds.length === 1, `exactly one refund sent (got ${client.refunds.length})`);
  ok(client.refunds[0]?.base === UCT(1), 'the full 1 UCT that arrived is returned, no fee');
  const bodies = client.dms.map((m) => m.content);
  ok(bodies.some((x) => /1 UCT/.test(x)), 'the poster is told the amount, not "nothing to refund"');
  ok(!bodies.some((x) => /nothing to refund/i.test(x)), 'the nothing-held wording never appears when money moved');
}

console.log(`\n  ${passed} passed, ${failed} failed`);
console.log(failed === 0
  ? '  ✅ ALL PASS — a bounty that closes with nothing held still says so.'
  : '  ❌ FAILURES — a terminal transition is still silent.');
process.exit(failed === 0 ? 0 : 1);
