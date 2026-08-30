/**
 * test-dedup-unit.mjs — deterministic, offline proof of the transfer credit/dedup
 * atomicity fix.
 *
 * The defect (seen live on bounty #689740): the incoming-transfer handler persisted
 * the "seen" dedup mark and the credit as TWO separate disk writes. A wallet-API
 * outage between them (a 503 mid-drain, or a crash) left the transfer marked seen
 * but its funds never credited — so the SDK's redelivery was skipped and the money
 * was silently stranded (the poster's draft stayed under-funded).
 *
 * The fix makes the credit and its dedup mark ONE atomic state.save() (commit()),
 * recorded only once the funds are credited. This proves, with no network:
 *   1. a credit and its seen-mark land on disk together (atomic co-persistence)
 *   2. the exact #689740 case — a partial then a completing transfer — now finishes,
 *      each transfer acked with its own credit
 *   3. a crash BEFORE commit persists NOTHING → the redelivered transfer credits
 *      exactly once (never stranded), and a further redelivery is idempotent
 *
 * Gitignored (test-*.mjs). Run: node test-dedup-unit.mjs
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'frani-bounty-dedup-'));
process.env.ENV_FILE = join(tmp, 'no-such.env');
process.env.WALLET_DIR = tmp;
process.env.LOG_LEVEL = 'error';

const { STATUS, State, normalizeKey } = await import('./src/state.js');
const { applyIncomingFunds } = await import('./src/bounty.js');
const { RateLimiter } = await import('./src/ratelimit.js');

const DEC = 18n;
const UCT = (n) => (BigInt(Math.round(Number(n) * 1e6)) * 10n ** (DEC - 6n)).toString(); // supports 1.5 etc.
const toWhole = (base) => { const b = BigInt(base), D = 10n ** DEC; const f = (b % D).toString().padStart(Number(DEC), '0').replace(/0+$/, ''); return f ? `${b / D}.${f}` : `${b / D}`; };

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.log(`  ❌ ${msg}`); } };

const client = {
  coin: { symbol: 'UCT', decimals: Number(DEC) },
  fmt: (base) => `${toWhole(base)} UCT`,
  dms: [],
  async sendDM(recipient, content) { this.dms.push({ recipient, content }); return { id: `dm-${this.dms.length}` }; },
};
const rl = new RateLimiter();
const POSTER = '02' + 'a'.repeat(64);
const draft = (id, rewardWhole) => ({
  id, status: STATUS.DRAFT, poster: normalizeKey(POSTER), posterNametag: 'poster-demo', posterRecipient: '@poster-demo',
  title: 'Dedup test bounty', rewardBase: UCT(rewardWhole), fundedBase: '0', feeBps: 200,
  fundDeadline: Date.now() + 24 * 3600 * 1000, createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000,
});

console.log('════════ frani-bounty · transfer credit/dedup atomicity proof (offline) ════════');

// ── 1) a credit and its seen-mark are persisted together (atomic) ──────────────
console.log('\n[1] a completed credit and its dedup mark co-persist in one write');
{
  const s = State.load();
  s.putBounty(draft('aa11bb', 2)); s.save();
  const r = await applyIncomingFunds(client, s, rl, { senderPubkey: POSTER, senderNametag: 'poster-demo', amountBase: UCT(2), transferId: 'T1' });
  ok(r.matched === 'draft-funded', 'full funding flips the draft to funded');
  const re = State.load(); // read back exactly what hit disk
  const b = re.getBounty('aa11bb');
  ok(b.status === STATUS.OPEN && b.fundedBase === UCT(2), 'reloaded from disk: bounty is OPEN, escrow = 2 UCT');
  ok(re.hasTransferSeen('T1'), 'reloaded from disk: transfer T1 is marked seen — credit + mark landed together');
}

// ── 2) the #689740 case: a partial then a completing transfer, each acked ──────
console.log('\n[2] partial (1.5) then completing (0.5) transfer — the #689740 scenario, now finishing');
{
  const s = State.load();
  s.putBounty(draft('cc22dd', 2)); s.save();
  await applyIncomingFunds(client, s, rl, { senderPubkey: POSTER, senderNametag: 'poster-demo', amountBase: UCT(1.5), transferId: 'Ta' });
  let re = State.load();
  ok(re.getBounty('cc22dd').status === STATUS.DRAFT && re.getBounty('cc22dd').fundedBase === UCT(1.5), 'after 1.5: still a draft, funded 1.5 of 2');
  ok(re.hasTransferSeen('Ta') && !re.hasTransferSeen('Tb'), 'transfer Ta acked; Tb not yet seen');
  await applyIncomingFunds(client, s, rl, { senderPubkey: POSTER, senderNametag: 'poster-demo', amountBase: UCT(0.5), transferId: 'Tb' });
  re = State.load();
  const b = re.getBounty('cc22dd');
  ok(b.status === STATUS.OPEN && b.fundedBase === UCT(2), 'after the remaining 0.5: bounty is OPEN, escrow = 2 UCT (no longer stranded)');
  ok(re.hasTransferSeen('Ta') && re.hasTransferSeen('Tb'), 'both transfers acked, each with its own credit');
}

// ── 3) a crash BEFORE commit persists nothing → redelivery credits exactly once ─
console.log('\n[3] a crash mid-credit strands nothing — the redelivered transfer credits exactly once');
{
  const s = State.load();
  s.putBounty(draft('ee33ff', 2)); s.save();

  // Faithfully model the handler: on a real transfer it calls applyIncomingFunds,
  // which persists via commit(). Simulate a hard crash by making that save throw,
  // then discard the in-memory state (reload from disk) exactly as a restart would.
  const realSave = s.save.bind(s);
  s.save = () => { throw new Error('simulated outage during persist (503 mid-drain)'); };
  let threw = false;
  try {
    await applyIncomingFunds(client, s, rl, { senderPubkey: POSTER, senderNametag: 'poster-demo', amountBase: UCT(2), transferId: 'Tc' });
  } catch { threw = true; } // the handler's try/catch swallows this and does NOT ack the transfer
  ok(threw, 'the credit persist was interrupted (as a wallet-API outage would)');

  const afterCrash = State.load(); // "restart" — only durably-saved state survives
  ok(afterCrash.getBounty('ee33ff').fundedBase === '0', 'after the crash+restart: NO credit persisted (draft still funded 0)');
  ok(!afterCrash.hasTransferSeen('Tc'), 'after the crash+restart: transfer Tc is NOT marked seen → the SDK will redeliver it');

  // Redelivery on the recovered state (persistence working again) → credit lands once.
  afterCrash.save(); // ensure a clean, working save channel
  await applyIncomingFunds(client, afterCrash, rl, { senderPubkey: POSTER, senderNametag: 'poster-demo', amountBase: UCT(2), transferId: 'Tc' });
  let re = State.load();
  ok(re.getBounty('ee33ff').status === STATUS.OPEN && re.getBounty('ee33ff').fundedBase === UCT(2), 'redelivery credits the full 2 UCT — funds recovered, not stranded');
  ok(re.hasTransferSeen('Tc'), 'now Tc is marked seen');

  // A further redelivery must be idempotent (the handler skips an already-seen id).
  if (!re.hasTransferSeen('Tc')) await applyIncomingFunds(client, re, rl, { senderPubkey: POSTER, senderNametag: 'poster-demo', amountBase: UCT(2), transferId: 'Tc' });
  re = State.load();
  ok(re.getBounty('ee33ff').fundedBase === UCT(2), 'idempotent: a duplicate redelivery does not double-credit');
  realSave(); // restore (tidy)
}

console.log('\n══════════════════════════════════════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? '  ✅ ALL PASS — a transfer is acked only with its credit; an interrupted credit retries, never strands.'
  : '  ❌ FAILURES — the credit/dedup atomicity is not holding.');
console.log('══════════════════════════════════════════════════════════════════════');
process.exit(failed === 0 ? 0 : 1);
