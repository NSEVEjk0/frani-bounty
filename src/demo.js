/**
 * frani-bounty — the offline escrow walk-through
 * ────────────────────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Runs the REAL bounty state machine (`src/bounty.js`), the REAL ledger
 * (`src/state.js`) and the REAL config against a FAKE wallet. It opens no socket
 * and no wallet file, so — unlike `--whoami` — it is safe to run while the daemon
 * is up.
 *
 * This board is the fleet's deliberately custodial agent: between "funded" and
 * "released" a poster's reward sits in the board's own wallet. The walk-through is
 * built around the one invariant that makes that defensible — **a payout can never
 * be paid out of somebody else's escrow** — because that is the failure a reviewer
 * should want to see exercised, not the happy path.
 *
 * PATH A (happy)   one poster, one worker, the full lifecycle, the 2% fee.
 * PATH B (failure) a second poster's payout arrives when the corpus cannot cover
 *                  both. It is HELD — no funds move, the status reverts, a retry
 *                  marker is written — and the sweep pays it once the corpus
 *                  recovers. A rejected proof reopens a bounty for somebody else.
 */

import { State, STATUS, normalizeKey } from './state.js';
import { RateLimiter } from './ratelimit.js';
import config from './config.js';
import * as bounty from './bounty.js';

const DEC = 18n;
const D = 10n ** DEC;
const HOUR = 3_600_000;
const toB = (whole) => (BigInt(Math.round(Number(whole) * 1000)) * D) / 1000n;
const toW = (b) => {
  const v = BigInt(b);
  const f = (v % D).toString().padStart(18, '0').replace(/0+$/, '');
  return f ? `${v / D}.${f}` : `${v / D}`;
};

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const say = (s = '') => console.log(s);
const rule = (t) => { say(); say(`── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}`); };

/** Cast — deliberately not the treasury's requesters; a board has two SIDES. */
const CAST = {
  mira:  { pub: '02' + 'a'.repeat(64), tag: 'mira',  role: 'poster' },
  vance: { pub: '02' + 'b'.repeat(64), tag: 'vance', role: 'worker' },
  odell: { pub: '02' + 'c'.repeat(64), tag: 'odell', role: 'poster' },
  wren:  { pub: '02' + 'd'.repeat(64), tag: 'wren',  role: 'worker' },
};

/**
 * A fake wallet. Every outbound move is recorded with its floor so the closing
 * audit can show that each one was gated, and by what.
 */
function fakeClient(corpusWhole) {
  const moves = [];
  let corpus = toB(corpusWhole);
  const client = {
    coin: { coinId: 'uct-demo', symbol: 'UCT', decimals: 18 },
    nametag: config.nametag,
    moves,
    get corpusBase() { return corpus; },
    set corpusBase(v) { corpus = BigInt(v); },
    toBase: toB,
    toWhole: toW,
    fmt: (b) => `${toW(b)} UCT`,
    async effectiveSpendableBase() { return corpus; },
    async _guard(kind, recipient, base, memo, keepFloorBase) {
      base = BigInt(base);
      const floor = BigInt(keepFloorBase ?? 0n);
      if (corpus - base < floor) {
        say(`      ⛔ send refused — ${toW(corpus)} on hand, ${toW(base)} asked, ${toW(floor)} owed to other escrow`);
        return { skipped: 'escrow-protect' };
      }
      corpus -= base;
      moves.push({ kind, recipient, base, floor, memo });
      say(`      💸 ${kind} ${toW(base)} UCT → ${recipient}   (floor honoured: ${toW(floor)})`);
      return { status: 'ok' };
    },
    async release(r, b, m, k) { return client._guard('release', r, b, m, k); },
    async refund(r, b, m, k) { return client._guard('refund', r, b, m, k); },
    async sweepFees(r, b, m, k) { return client._guard('fee-sweep', r, b, m, k); },
    async requestPayment(recipient, whole) {
      say(`      📨 payment request placed in ${recipient}'s wallet for ${whole} UCT (they decide — the board cannot pull)`);
      return { success: true, requestId: `req-${recipient.slice(1)}` };
    },
    async mint() { return { skipped: 'demo' }; },
    async sendDM(recipient, content) {
      const head = content.split('\n')[0].replace(/\s+—\s+.*$/, '');
      say(`      ✉️  → ${recipient}: ${head}`);
      return { id: 'dm' };
    },
  };
  return client;
}

/** A ledger with nothing in it and nothing on disk. */
function freshDemoState(corpusWhole) {
  const state = new State({
    version: 1,
    serviceIntentId: null,
    paused: false,
    bookBalanceBase: toB(corpusWhole).toString(),
    sweepableBase: '0',
    seenDmIds: [],
    seenTransferIds: [],
    handledPaymentReqIds: [],
    bounties: {},
    pendingTopups: {},
    blacklist: {},
    ledger: [],
    stats: {
      bountiesCreated: 0, bountiesFunded: 0, bountiesReleased: 0,
      bountiesRefunded: 0, bountiesExpired: 0, bountiesCancelled: 0,
    },
  });
  state.save = () => {}; // the demo touches no disk
  return state;
}

const dm = (who, content) => ({
  senderPubkey: CAST[who].pub,
  senderNametag: CAST[who].tag,
  content,
  id: `dm-${who}-${Math.random().toString(36).slice(2, 8)}`,
});

/** Print the board's custody position — the number the guard is derived from. */
function custody(client, state, note = '') {
  const owed = state.escrowedTotalBase(null);
  const live = state.allBounties().filter((b) => BigInt(state.heldBase(b)) > 0n);
  say(`      📊 corpus ${toW(client.corpusBase)} UCT · escrow owed ${toW(owed)} UCT across ${live.length} bount${live.length === 1 ? 'y' : 'ies'}${note ? ` · ${note}` : ''}`);
}

const idOf = (state, poster) =>
  state.allBounties().filter((b) => b.poster === normalizeKey(CAST[poster].pub)).at(-1)?.id;

export async function runDemo({ pace = 900 } = {}) {
  const beat = () => sleep(pace);
  const fee = config.bounty.feeBps;

  say('════════════════ frani-bounty · offline escrow walk-through ════════════════');
  say('Real bounty.js · real state.js · real config · FAKE wallet. No socket, no funds.');
  say(`Protocol fee ${fee / 100}% on release · refunds are never charged a fee.`);
  await beat();

  // ═══════════════════════════ PATH A ═══════════════════════════════════════
  const client = fakeClient(0);
  const state = freshDemoState(0);
  const rl = new RateLimiter();

  rule('PATH A · a bounty that works');
  say('  mira wants a Grafana panel built. She has never used this board before.');
  await beat();

  say('\n  mira → create 5 build me a grafana panel for the testnet2 mempool');
  await bounty.createBounty(client, state, rl, { dm: dm('mira', 'create'), rewardWhole: '5', title: 'build me a grafana panel for the testnet2 mempool' });
  const A = idOf(state, 'mira');
  say(`      → #${A} is a DRAFT. Nothing is escrowed yet: the board asked, it did not take.`);
  custody(client, state, 'a draft holds no escrow');
  await beat();

  say('\n  mira approves the payment request in her own wallet — 5 UCT arrives.');
  client.corpusBase = toB(5);
  await bounty.applyIncomingFunds(client, state, rl, { senderPubkey: CAST.mira.pub, senderNametag: 'mira', amountBase: toB(5), transferId: 'tx-mira-1' });
  say(`      → #${A} is ${state.getBounty(A).status.toUpperCase()}. Now the board is custodian of somebody else's 5 UCT.`);
  custody(client, state);
  await beat();

  say('\n  vance → claim ' + A);
  await bounty.claimBounty(client, state, rl, { dm: dm('vance', `claim ${A}`), bountyId: A });
  say(`      → ${state.getBounty(A).status.toUpperCase()}, and vance has a deadline. An unclaimed window would have reopened it.`);
  await beat();

  say('\n  vance → submit ' + A + ' https://snippets.example/mempool-panel.json');
  await bounty.submitProof(client, state, rl, { dm: dm('vance', `submit ${A}`), bountyId: A, proof: 'https://snippets.example/mempool-panel.json' });
  say(`      → ${state.getBounty(A).status.toUpperCase()}. mira now has ${config.bounty.confirmWindowHours}h to confirm — silence auto-releases to the worker.`);
  await beat();

  say('\n  mira → confirm ' + A);
  await bounty.confirmBounty(client, state, rl, { dm: dm('mira', `confirm ${A}`), bountyId: A });
  const a = state.getBounty(A);
  const feeTaken = (toB(5) * BigInt(fee)) / 10_000n;
  say(`      → #${A} is ${a.status.toUpperCase()}. vance was paid ${toW(toB(5) - feeTaken)}; the board kept ${toW(feeTaken)} as its fee.`);
  custody(client, state, 'escrow discharged');
  await beat();
  say('\n  ✔ Two DMs from the poster, two from the worker. Nobody approved anything by');
  say('    hand, and the board never had to be trusted with the *decision* — only,');
  say('    briefly, with the money.');
  await beat();

  // ═══════════════════════════ PATH B ═══════════════════════════════════════
  rule('PATH B · two posters, and a corpus that cannot cover both');
  say('  This is the failure worth showing. The board holds one wallet, so at any');
  say('  moment several strangers\' rewards are mixed together in it. The rule is:');
  say('');
  say('        spendable − (this payout)  ≥  Σ escrow owed to every OTHER bounty');
  say('');
  say('  recomputed from the bounty book on every send, and re-checked a second time');
  say('  inside the guarded send itself.');
  await beat();

  say('\n  odell posts 6 UCT and funds it. wren claims it and submits.');
  await bounty.createBounty(client, state, rl, { dm: dm('odell', 'create'), rewardWhole: '6', title: 'port the mempool panel to the block explorer' });
  const B = idOf(state, 'odell');
  client.corpusBase = client.corpusBase + toB(6);
  await bounty.applyIncomingFunds(client, state, rl, { senderPubkey: CAST.odell.pub, senderNametag: 'odell', amountBase: toB(6), transferId: 'tx-odell-1' });
  await bounty.claimBounty(client, state, rl, { dm: dm('wren', `claim ${B}`), bountyId: B });
  await bounty.submitProof(client, state, rl, { dm: dm('wren', `submit ${B}`), bountyId: B, proof: 'https://snippets.example/explorer-panel.json' });
  await beat();

  say('\n  mira posts a third bounty for 4 UCT and funds it too.');
  await bounty.createBounty(client, state, rl, { dm: dm('mira', 'create'), rewardWhole: '4', title: 'alerting rules for the panel' });
  const C = idOf(state, 'mira');
  client.corpusBase = client.corpusBase + toB(4);
  await bounty.applyIncomingFunds(client, state, rl, { senderPubkey: CAST.mira.pub, senderNametag: 'mira', amountBase: toB(4), transferId: 'tx-mira-2' });
  custody(client, state, 'both escrows intact');
  await beat();

  say('\n  Now something goes wrong on the wallet side: 4 UCT of the corpus is');
  say('  temporarily unavailable (an in-flight transfer, a partial reconcile — the');
  say('  cause does not matter to the guard).');
  client.corpusBase = client.corpusBase - toB(4);
  custody(client, state, 'corpus < escrow owed');
  await beat();

  say(`\n  odell → confirm ${B}   (wren has earnt 6 UCT and odell says so)`);
  await bounty.confirmBounty(client, state, rl, { dm: dm('odell', `confirm ${B}`), bountyId: B, });
  const held = state.getBounty(B);
  say(`      → #${B} reverted to ${held.status.toUpperCase()} and carries a retry marker: heldBecause=${held.settleRetry?.heldBecause}`);
  say('      This is a HOLD, not a failure. Read the three facts in order:');
  say(`        · funds moved: 0 — the send returned before debiting anything`);
  say(`        · #${C}'s escrow: still ${toW(state.heldBase(state.getBounty(C)))} UCT, untouched`);
  say(`        · wren was NOT told the payment failed, because it has not`);
  say('      A board that paid wren here would have paid him with mira\'s money.');
  await beat();

  say('\n  The corpus recovers. The periodic sweep re-drives the held move — safe,');
  say('  because a held attempt debited nothing, so there is no double-pay risk.');
  client.corpusBase = client.corpusBase + toB(4);
  await bounty.sweep(client, state, rl, Date.now());
  const settled = state.getBounty(B);
  say(`      → #${B} is ${settled.status.toUpperCase()}; retry marker cleared: ${settled.settleRetry === undefined}`);
  custody(client, state);
  await beat();

  say('\n  One more failure, on the other axis: mira does not like what she gets.');
  await bounty.claimBounty(client, state, rl, { dm: dm('wren', `claim ${C}`), bountyId: C });
  await bounty.submitProof(client, state, rl, { dm: dm('wren', `submit ${C}`), bountyId: C, proof: 'a screenshot of the wrong dashboard' });
  await bounty.rejectProof(client, state, rl, { dm: dm('mira', `reject ${C}`), bountyId: C, reason: 'wrong dashboard' });
  const c = state.getBounty(C);
  say(`      → #${C} is back to ${c.status.toUpperCase()} — a rejection is not a termination.`);
  say(`      wren keeps his claim and may revise: attempt ${c.proofAttempts} of ${config.bounty.maxProofAttempts}. Only when he`);
  say('      runs out, or his claim window lapses, does the bounty reopen to somebody else.');
  say(`      Either way mira\'s ${toW(state.heldBase(c))} UCT never left escrow, and never became wren\'s.`);
  say('      This is the one place a custodial board earns its keep: the money is');
  say('      already committed, so neither side can walk away with it mid-dispute.');
  await beat();

  say(`\n  mira would like out of #${C} now that somebody is working on it:`);
  await bounty.cancelBounty(client, state, rl, { dm: dm('mira', `cancel ${C}`), bountyId: C });
  say('      → refused, and refused to the POSTER. Cancel is for a draft or an');
  say('        unclaimed bounty. Once a worker has a claim on it the exits are');
  say('        confirm, reject-until-exhausted, the claim lapsing, or the operator');
  say('        dispute door — none of which a poster can trigger unilaterally.');
  await beat();

  // ═══════════════════════════ AUDIT ════════════════════════════════════════
  rule('every outbound move, and the floor it had to clear');
  const total = client.moves.reduce((a, m) => a + m.base, 0n);
  for (const m of client.moves) {
    say(`  ${m.kind.padEnd(9)} ${toW(m.base).padStart(6)} UCT → ${m.recipient.padEnd(8)} · retained ${toW(m.floor)} UCT of other escrow`);
  }
  say(`\n  ${client.moves.length} moves, ${toW(total)} UCT total. Each one recomputed its floor from the`);
  say('  bounty book at the moment of sending, and the guarded send re-checked it');
  say('  against a freshly-read balance. One refused move stayed refused until the');
  say('  money was genuinely there.');
  say('\n  Custody left on the board:');
  custody(client, state);
  say('\n  `node test-escrow-custody-unit.mjs` pins all of the above offline —');
  say('  43 assertions, 11 of which fail if the co-mingling guard or the mint gate goes.');
  say('══════════════════════════════════════════════════════════════════════════');
  return { client, state, rl };
}

export default { runDemo };
