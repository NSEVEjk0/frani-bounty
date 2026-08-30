/**
 * test-escrow-custody-unit.mjs — offline proof that one bounty's payout can never
 * be paid out of another bounty's escrow.
 *
 * This board is custodial ON PURPOSE. A poster's reward sits in the board's own
 * wallet between funding and release, which means at any moment the wallet holds a
 * pile of UCT belonging to several different people at once. There is no per-bounty
 * sub-account and the SDK has no escrow primitive to lean on — so the separation is
 * an INVARIANT the code has to hold, not a property the network gives us:
 *
 *     spendable − (this payout) ≥ Σ escrow still owed to every OTHER bounty
 *
 * The floor is recomputed from the bounty book on every single send
 * (`state.escrowedTotalBase(exceptId)`), never read from a running counter that
 * could drift, and it is re-checked a second time INSIDE the guarded send — so a
 * bug in the state machine cannot pay Kade out of Mara's escrow even if the state
 * machine asks it to.
 *
 * What this pins, in order:
 *   [1] the floor is derived from the book, and moves when the book moves
 *   [2] a payout that would eat another escrow is REFUSED, and refused as HELD:
 *       prior status restored, no funds moved, a retry marker left behind
 *   [3] the sweep re-drives that held payout once the corpus recovers — a held
 *       payout is a promise deferred, not a promise broken
 *   [4] a refund is charged NO fee, and goes to the POSTER; a release is charged
 *       the fee, and goes to the WORKER. The two are never crossed.
 *   [5] the fee is never taken out of another bounty's escrow either
 *   [6] an unconfirmed send is never retried and never recorded as released
 *   [7] a wallet-api outage (`assets()` → []) must not read as corpus 0, because
 *       a false zero trips the escrow floor on EVERY payout and strands every
 *       worker's reward — the outage is the custody bug, not just a display bug
 *
 * Offline: `SphereClient` takes an injected sphere, so no network, no wallet, no
 * funds. Gitignored by default (test-*.mjs) and negated explicitly. Run:
 *   node test-escrow-custody-unit.mjs
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'frani-bounty-escrow-'));
process.env.ENV_FILE = join(tmp, 'no-such.env');
process.env.WALLET_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.env.MIN_BALANCE_FLOOR_UCT = '0'; // isolate the ESCROW floor from the operational one
process.env.SELF_MINT_ENABLED = 'true';  // so section [8] can reach the bootstrap path at all
process.env.SELF_MINT_AMOUNT = '25';

const { SphereClient } = await import('./src/sphere-client.js');
const { State, STATUS, normalizeKey } = await import('./src/state.js');
const { RateLimiter } = await import('./src/ratelimit.js');
const { default: config } = await import('./src/config.js');
const bounty = await import('./src/bounty.js');

const DEC = 18n;
const D = 10n ** DEC;
const base = (whole) => (BigInt(Math.round(Number(whole) * 1000)) * D) / 1000n;
const whole = (b) => {
  const v = BigInt(b), f = (v % D).toString().padStart(18, '0').replace(/0+$/, '');
  return f ? `${v / D}.${f}` : `${v / D}`;
};
const COIN = { coinId: 'uct-coin-id', symbol: 'UCT', decimals: 18 };
const HOUR = 3_600_000;

let passed = 0, failed = 0;
const ok = (cond, msg, got) => {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}${got !== undefined ? ` — got ${got}` : ''}`); }
};

// Four distinct identities: two posters who do not know each other, two workers.
const MARA = '02' + '1'.repeat(64);   // poster of #A
const NILS = '02' + '2'.repeat(64);   // poster of #B
const KADE = '02' + '3'.repeat(64);   // worker on #A
const RUTH = '02' + '4'.repeat(64);   // worker on #B

/**
 * A fake sphere. `corpus` is what the wallet-api reports; `sends` records every
 * outbound attempt so a refusal can be told apart from a silent success.
 */
function makeSphere({ corpusWhole = 0, sendMode = 'ok' } = {}) {
  const sphere = {
    sends: [],
    corpus: base(corpusWhole),
    outage: false,
    payments: {
      async assets() {
        if (sphere.outage) return []; // the real shape of an unreachable wallet-api
        return [{
          coinId: COIN.coinId,
          confirmedAmount: sphere.corpus.toString(),
          transferringAmount: '0',
          unconfirmedAmount: '0',
        }];
      },
      async send({ recipient, amount, memo }) {
        sphere.sends.push({ recipient, amount: BigInt(amount), memo });
        if (sendMode === 'throw') { const e = new Error('CHECKPOINT_PERSIST_FAILED: split burn certified'); e.code = 'CERTIFICATION_UNCONFIRMED'; throw e; }
        if (sendMode === 'error') return { error: 'wallet-api unreachable' };
        sphere.corpus -= BigInt(amount);
        return { status: 'ok' };
      },
      async requests() { return { create: async () => ({ success: false }) }; },
      requestsNs: null,
      async mint() { throw new Error('mint must not be called here'); },
    },
    identity: { chainPubkey: '02' + 'f'.repeat(64) },
    async sendMessage() { return { id: 'dm' }; },
  };
  sphere.payments.requests = { create: async () => ({ success: false, error: 'offline' }) };
  return sphere;
}

/** A board holding two SUBMITTED bounties from two different posters. */
function board(sphere, { rewardA = 10, rewardB = 10 } = {}) {
  const client = new SphereClient(sphere, COIN, 'device-test', false);
  client.dms = [];
  client.sendDM = async (recipient, content) => { client.dms.push({ recipient, content }); return { id: 'dm' }; };

  const state = State.load();
  for (const b of state.allBounties?.() ?? Object.values(state.data.bounties ?? {})) delete state.data.bounties[b.id];
  state.data.bookBalanceBase = undefined;
  client.attachState(state);

  const now = Date.now();
  const mk = (id, posterPub, posterTag, workerPub, workerTag, rewardWhole) => {
    const b = {
      id,
      poster: normalizeKey(posterPub), posterRecipient: `@${posterTag}`, posterNametag: posterTag,
      claimer: normalizeKey(workerPub), claimerRecipient: `@${workerTag}`, claimerNametag: workerTag,
      rewardBase: base(rewardWhole).toString(), fundedBase: base(rewardWhole).toString(),
      feeBps: config.bounty.feeBps, title: `job ${id}`,
      status: STATUS.SUBMITTED, proof: 'here is the work', proofAttempts: 1,
      paymentRequestId: null, createdAt: now - 3 * HOUR, updatedAt: now,
      fundDeadline: now + HOUR, fundedAt: now - 2 * HOUR, claimedAt: now - 2 * HOUR,
      submittedAt: now - HOUR, resolvedAt: null,
      claimDeadline: now + 10 * HOUR, confirmDeadline: now + 100 * HOUR, openExpiryAt: now + 100 * HOUR,
      reminders: {}, releaseUnconfirmed: false, refundUnconfirmed: false, outcome: null,
    };
    state.putBounty(b);
    return b;
  };
  const A = mk('a1beef', MARA, 'mara', KADE, 'kade', rewardA);
  const B = mk('b2cafe', NILS, 'nils', RUTH, 'ruth', rewardB);
  state.save();
  return { client, state, rl: new RateLimiter(), A, B };
}

const dmFrom = (pub, tag, content) => ({ senderPubkey: pub, senderNametag: tag, content, id: `m-${content.length}-${pub.slice(2, 8)}` });
const said = (client, tag) => client.dms.filter((m) => m.recipient === `@${tag}`).map((m) => m.content).join('\n');

console.log('════════ frani-bounty · escrow-custody unit proof (offline) ════════');
console.log(`fee ${config.bounty.feeBps / 100}% · operational floor pinned to 0 so only the ESCROW floor is under test`);

// ── [1] the floor is derived from the book ───────────────────────────────────
console.log('\n[1] the co-mingling floor is recomputed from the bounty book, not counted');
{
  const { state, A, B } = board(makeSphere({ corpusWhole: 20 }));
  ok(state.escrowedTotalBase(A.id) === base(10), `paying #A must retain #B's 10 UCT (got ${whole(state.escrowedTotalBase(A.id))})`);
  ok(state.escrowedTotalBase(B.id) === base(10), 'and symmetrically for #B');
  ok(state.escrowedTotalBase(null) === base(20), 'total custody across the board is 20 UCT');

  // A third bounty appears → the floor for #A moves immediately, with no counter to update.
  state.putBounty({ ...A, id: 'c3face', poster: normalizeKey(NILS), rewardBase: base(4).toString(), fundedBase: base(4).toString() });
  ok(state.escrowedTotalBase(A.id) === base(14), 'a new funded bounty raises the floor at once');
  delete state.data.bounties.c3face;
  ok(state.escrowedTotalBase(A.id) === base(10), 'and removing it lowers it again — the book IS the counter');
}

// ── [2] a payout that would eat another escrow is refused, and HELD ──────────
console.log("\n[2] Kade's reward is never paid out of Nils's escrow");
{
  // 12 UCT on hand, 20 UCT owed. #A's payout is 9.8 — affordable in isolation,
  // impossible without dipping into #B.
  const sphere = makeSphere({ corpusWhole: 12 });
  const { client, state, rl, A, B } = board(sphere);
  const res = await bounty.confirmBounty(client, state, rl, { dm: dmFrom(MARA, 'mara', `confirm ${A.id}`), bountyId: A.id });

  ok(sphere.sends.length === 0, `no UCT left the wallet (got ${sphere.sends.length} send(s))`);
  ok(res?.held === true || res?.ok === false, 'the release did not report success');

  const a = state.getBounty(A.id);
  ok(a.status === STATUS.SUBMITTED, `#A is back in its prior status, not stuck in RELEASING (got ${a.status})`);
  ok(a.releasingBase === undefined, 'the in-flight marker was cleared');
  ok(!!a.settleRetry, 'a retry marker was left — this is HELD, not failed');
  ok(a.settleRetry?.heldBecause === 'escrow-protect', `held for the right reason (got ${a.settleRetry?.heldBecause})`);

  ok(state.getBounty(B.id).status === STATUS.SUBMITTED, "#B is untouched");
  ok(state.escrowedTotalBase(null) === base(20), "and every UCT of both escrows is still owed");
  ok(/safe|shortly|protecting/i.test(said(client, 'kade')) || said(client, 'kade') === '',
    'the worker is not told the reward failed');
}

// ── [3] held is a promise deferred: the sweep re-drives it ───────────────────
console.log('\n[3] once the corpus recovers, the sweep pays the held reward');
{
  const sphere = makeSphere({ corpusWhole: 12 });
  const { client, state, rl, A, B } = board(sphere);
  await bounty.confirmBounty(client, state, rl, { dm: dmFrom(MARA, 'mara', `confirm ${A.id}`), bountyId: A.id });
  ok(!!state.getBounty(A.id).settleRetry, 'the payout starts out held');

  sphere.corpus = base(40);                 // somebody funded the board / the book reconciled up
  state.data.bookBalanceBase = undefined;   // let it re-read
  await bounty.sweep(client, state, rl, Date.now());

  const a = state.getBounty(A.id);
  ok(sphere.sends.length === 1, `exactly one send happened on the retry (got ${sphere.sends.length})`);
  ok(a.status === STATUS.RELEASED, `#A is now RELEASED (got ${a.status})`);
  ok(a.settleRetry === undefined, 'the retry marker is cleared once it lands');
  ok(state.getBounty(B.id).status === STATUS.SUBMITTED, "#B was never touched by #A's retry");
}

// ── [4] the fee falls on the release, never on the refund ────────────────────
console.log('\n[4] release pays the WORKER minus fee; refund pays the POSTER in full');
{
  const sphere = makeSphere({ corpusWhole: 100 });
  const { client, state, rl, A, B } = board(sphere);
  await bounty.confirmBounty(client, state, rl, { dm: dmFrom(MARA, 'mara', `confirm ${A.id}`), bountyId: A.id });

  const rel = sphere.sends.at(-1);
  const fee = (base(10) * BigInt(config.bounty.feeBps)) / 10_000n;
  ok(rel.recipient === '@kade', `the reward went to the worker (got ${rel.recipient})`);
  ok(rel.recipient !== '@mara', 'not to the poster');
  ok(rel.amount === base(10) - fee, `the worker got reward − fee = ${whole(base(10) - fee)} (got ${whole(rel.amount)})`);

  // A worker is not stripped of a submitted claim by the poster changing their mind:
  // `cancel` is refused outright once somebody is working on it.
  const cancel = await bounty.cancelBounty(client, state, rl, { dm: dmFrom(NILS, 'nils', `cancel ${B.id}`), bountyId: B.id });
  ok(cancel?.ok === false, 'a poster cannot cancel a bounty that has work submitted on it');
  ok(state.getBounty(B.id).status === STATUS.SUBMITTED, 'so #B stays submitted');

  // The dispute door is the operator's, and it returns the escrow whole.
  const before = sphere.sends.length;
  await bounty.ownerResolve(client, state, rl, { dm: dmFrom(config.ownerPubkey || NILS, 'itachi', `resolve ${B.id} refund`), bountyId: B.id, action: 'refund' });
  ok(sphere.sends.length === before + 1, 'the dispute refund moves exactly one payment');
  const ref = sphere.sends.at(-1);
  ok(ref.recipient === '@nils', `the refund went to the poster (got ${ref.recipient})`);
  ok(ref.recipient !== '@ruth', 'not to the worker who was on it');
  ok(ref.amount === base(10), `the poster got the WHOLE reward back, no fee (got ${whole(ref.amount)})`);
  ok(/refund/i.test(said(client, 'nils')), 'and the poster is told in writing');
  ok(state.getBounty(B.id).status === STATUS.REFUNDED, `#B is terminal (got ${state.getBounty(B.id).status})`);
}

// ── [5] the fee sweep is bound by the same floor ─────────────────────────────
console.log("\n[5] the board cannot sweep its own fees out of somebody's escrow");
{
  const sphere = makeSphere({ corpusWhole: 20 });
  const { client, state } = board(sphere);
  const floor = state.escrowedTotalBase(null);
  ok(floor === base(20), 'all 20 UCT on hand is owed to posters');
  const res = await client.sweepFees('@itachi', base(1), 'fees', floor);
  ok(res?.skipped === 'escrow-protect', `the fee sweep is refused (got ${JSON.stringify(res)})`);
  ok(sphere.sends.length === 0, 'and nothing moved');
}

// ── [6] an unconfirmed release is never retried, never claimed ───────────────
console.log('\n[6] an unconfirmed send is neither retried nor recorded as paid');
{
  const sphere = makeSphere({ corpusWhole: 100, sendMode: 'throw' });
  const { client, state, rl, A } = board(sphere);
  await bounty.confirmBounty(client, state, rl, { dm: dmFrom(MARA, 'mara', `confirm ${A.id}`), bountyId: A.id });

  const a = state.getBounty(A.id);
  ok(sphere.sends.length === 1, 'the send was attempted exactly once');
  ok(a.releaseUnconfirmed === true, 'it is recorded as UNCONFIRMED');
  ok(a.status !== STATUS.SUBMITTED, 'it is not left dangling as if nothing happened');

  const before = sphere.sends.length;
  await bounty.sweep(client, state, rl, Date.now());
  ok(sphere.sends.length === before, 'and the sweep does NOT resend it — the burn may already be certified');
}

// ── [7] an outage is a custody bug, not a display bug ────────────────────────
console.log('\n[7] a wallet-api outage must not read as corpus 0 — a false zero strands every worker');
{
  const sphere = makeSphere({ corpusWhole: 100 });
  const { client, state, rl, A } = board(sphere);
  await client.effectiveSpendableBase();          // anchor the book at the true 100
  sphere.outage = true;                            // assets() now resolves with []

  const b = await client.effectiveSpendableBase();
  ok(b === base(100), `the outage reports the last known book, not 0 (got ${whole(b)})`);

  await bounty.confirmBounty(client, state, rl, { dm: dmFrom(MARA, 'mara', `confirm ${A.id}`), bountyId: A.id });
  ok(sphere.sends.length === 1, 'the reward still goes out during the outage');
  ok(state.getBounty(A.id).status === STATUS.RELEASED, "and #A is released, not held on a phantom escrow breach");

  sphere.outage = false;
  const after = await client.effectiveSpendableBase();
  ok(after > 0n, `the book is not poisoned by the outage (got ${whole(after)})`);
}

// ── [8] a phantom corpus is the same bug as a crossed payout ─────────────────
// The bootstrap self-mint is the one balance-gated decision left in the agent, and
// on a CUSTODIAL board reading an outage as "wallet is empty" is worse than a
// cosmetic slip: a second seed-mint inflates the corpus with UCT the board never
// earnt, and an inflated corpus makes the escrow floor pass when it should refuse.
// A payout cleared by phantom money is a payout made out of somebody else's escrow,
// one indirection removed.
console.log('\n[8] the bootstrap mint cannot inflate the corpus a payout is checked against');
{
  // Silence on a PRE-EXISTING wallet must never mint: the board may be holding
  // escrow it simply cannot see right now.
  const sphere = makeSphere({ corpusWhole: 30 });
  sphere.mints = 0;
  sphere.payments.mint = async () => { sphere.mints += 1; return { success: true, tokenId: 'deadbeef' }; };
  const client = new SphereClient(sphere, COIN, 'device-test', false); // created=false → pre-existing
  client.sendDM = async () => ({ id: 'dm' });
  sphere.outage = true;
  await client.bootstrapMintIfNeeded();
  ok(sphere.mints === 0, 'an unanswered balance on a pre-existing wallet does NOT seed-mint', sphere.mints);

  // …but a genuinely new identity still gets its documented one-time mint. testnet2
  // has no faucet, and a board with no corpus can never pay a worker at all.
  const s2 = makeSphere({ corpusWhole: 0 });
  s2.mints = 0;
  s2.payments.mint = async () => { s2.mints += 1; return { success: true, tokenId: 'cafebabe' }; };
  s2.payments.assets = async () => [];   // brand-new wallet: no row exists yet
  const fresh = new SphereClient(s2, COIN, 'device-test', true); // created=true → this very boot
  fresh.sendDM = async () => ({ id: 'dm' });
  await fresh.bootstrapMintIfNeeded();
  ok(s2.mints === 1, 'a wallet generated on this boot still performs its one-time mint', s2.mints);
}

console.log(`\n  ${passed} passed, ${failed} failed`);
console.log(failed === 0
  ? '  ✅ ALL PASS — no bounty is ever paid out of another bounty\'s escrow.'
  : '  ❌ FAILURES — custody separation is not holding.');
process.exit(failed === 0 ? 0 : 1);
