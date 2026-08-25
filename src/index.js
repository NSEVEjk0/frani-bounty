#!/usr/bin/env node
/**
 * frani-bounty — entrypoint
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Modes:
 *   node src/index.js               start the autonomous bounty-board daemon (default)
 *   node src/index.js --whoami      print identity + balance, then exit
 *   node src/index.js --doctor      connectivity / config self-check, then exit
 *   node src/index.js --status      print the live board status report, then exit
 *   node src/index.js --mint [amt]  capped self-mint (only if SELF_MINT_ENABLED), then exit
 *   node src/index.js --demo        explain the escrow lifecycle & fee math (no funds move), then exit
 */

import config from './config.js';
import { createLogger } from './logger.js';
import { SphereClient } from './sphere-client.js';
import { feeOf } from './money.js';

const log = createLogger('main');

const AMOUNT_RE = /^\d+(\.\d+)?$/;

function banner() {
  log.info('──────────────────────────────────────────────');
  log.info(' frani-bounty · autonomous bounty board & custodial escrow (Unicity testnet2)');
  log.info(` owner: ${config.owner}   ·   made by ${config.brand}`);
  log.info(` network: ${config.network}   dry-run: ${config.safety.dryRun}`);
  log.info(` reward ${config.bounty.minRewardWhole}–${config.bounty.maxRewardWhole} UCT · fee ${config.bounty.feeBps / 100}% on release · refunds always full`);
  log.info('──────────────────────────────────────────────');
}

async function reportStatus(client) {
  const balance = await client.spendableWhole();
  log.info(`Identity : ${client.describe()}`);
  log.info(`Pubkey   : ${client.identity.chainPubkey ?? '(n/a)'}  (set as OWNER_PUBKEY to enable admin)`);
  log.info(`Coin     : ${client.coin.symbol} (${client.coin.decimals} decimals)`);
  log.info(`Balance  : ${balance} ${client.coin.symbol} (spendable)`);
  log.info(`Outflow  : ${config.safety.releaseEnabled ? 'ENABLED' : 'DISABLED'} · auto-release on confirm-timeout ${config.safety.autoReleaseOnConfirmTimeout}`);
  log.info(`Admin    : ${config.admin.enabled ? 'enabled (owner DM)' : 'disabled'}`);
  log.info(`Wallet   : ${config.walletDir}  (device ${client.deviceId})`);
}

/** Print the shared board status report (same figures the DM `status` shows). */
async function printStatus(client) {
  const { State } = await import('./state.js');
  const { boardStatusLines } = await import('./services/commands.js');
  const state = State.load();
  client.attachState(state);
  const lines = await boardStatusLines(client, state, Date.now());
  log.info('\n' + lines.join('\n'));
}

/**
 * Walk through the escrow lifecycle end-to-end WITHOUT moving any funds: print the
 * state machine, a worked fee example computed with the real coin decimals, and the
 * exact windows/limits in force. The genuine on-network full-flow demo is driven
 * separately with two live identities (a poster and a claimer).
 */
async function runDemo(client) {
  const sym = client.coin.symbol;
  const t = config.bounty;
  const reward = client.toBase('5');
  const fee = feeOf(reward, t.feeBps);
  const payout = reward - fee;

  log.info('\n════════ frani-bounty · escrow lifecycle (no funds move) ════════');
  log.info('The board is a custodial escrow. A poster funds a reward into it; a worker');
  log.info('does the job; the poster confirms; the reward is released automatically.\n');

  log.info('STATE MACHINE');
  log.info('  draft  ──fund──▶  open  ──claim──▶  claimed  ──submit──▶  submitted  ──confirm──▶  RELEASED');
  log.info('    │                 │                  │                     │');
  log.info('    │ fund window     │ open expiry      │ claim window        │ confirm window');
  log.info('    ▼ elapses         ▼ (unclaimed)      ▼ (no proof)          ▼ (poster silent)');
  log.info('  EXPIRED           EXPIRED           reopens to open      AUTO-RELEASE to worker');
  log.info('  (refund any     (refund poster)    (claim lapses)       (the configured dispute policy)');
  log.info('   partial funds)');
  log.info('  A poster may `cancel` a draft/open bounty at any time → full refund. Refunds are NEVER charged a fee.\n');

  log.info(`WORKED EXAMPLE (fee ${t.feeBps / 100}%)`);
  log.info(`  Poster creates a bounty with a ${client.fmt(reward)} reward and funds it into escrow.`);
  log.info(`  On release the worker receives ${client.fmt(payout)}; the board keeps ${client.fmt(fee)} as the protocol fee.`);
  log.info(`  If the bounty is cancelled or expires instead, the poster gets the full ${client.fmt(reward)} back.\n`);

  log.info('WINDOWS & LIMITS IN FORCE');
  log.info(`  fund ${t.fundWindowHours}h · claim ${t.claimWindowHours}h · confirm ${t.confirmWindowHours}h · open expiry ${t.openExpiryDays}d`);
  log.info(`  reward ${t.minRewardWhole}–${t.maxRewardWhole} ${sym} · global custody cap ${t.maxTotalEscrowWhole} ${sym}`);
  log.info(`  ≤ ${t.maxOpenBountiesPerPoster} open bounties/poster · ≤ ${t.maxActiveClaimsPerClaimer} active claims/claimer · ≤ ${t.maxProofAttempts} proof attempts`);
  log.info(`  co-mingling guard: a payout can NEVER dip into another bounty's escrow (re-checked in the guarded send).\n`);

  log.info(`Live interaction is over DM to @${config.nametag}:`);
  log.info('  create <reward> <title> · claim <id> · submit <id> <proof> · confirm <id> · list · status · help');
  log.info('════════════════════════════════════════════════════════════════\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  banner();

  const client = await SphereClient.boot();

  // ── one-shot inspection / maintenance modes ───────────────────────────────
  if (args.has('--doctor')) {
    await client.ensureNametag();
    await reportStatus(client);
    log.info(`Connection: ${client.sphere.payments.connectionStatus?.() ?? 'n/a'}`);
    log.info('Doctor check complete. ✅');
    await client.destroy();
    process.exit(0); // one-shot modes force exit — open sockets would otherwise linger
  }

  if (args.has('--whoami')) {
    await reportStatus(client);
    await client.destroy();
    process.exit(0);
  }

  if (args.has('--status')) {
    await printStatus(client);
    await client.destroy();
    process.exit(0);
  }

  if (args.has('--mint')) {
    await client.ensureNametag();
    const amt = argv.find((a) => AMOUNT_RE.test(a)) ?? config.safety.selfMintAmountWhole;
    await client.mint(amt);
    await reportStatus(client);
    await client.destroy();
    process.exit(0);
  }

  if (args.has('--demo')) {
    await runDemo(client);
    await client.destroy();
    process.exit(0);
  }

  // ── default: run the autonomous bounty-board daemon ────────────────────────
  await client.ensureNametag();
  await client.bootstrapMintIfNeeded();
  await reportStatus(client);

  const { startAgent } = await import('./agent.js');
  const controller = new AbortController();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal} — shutting down gracefully…`);
    controller.abort();
    setTimeout(async () => {
      await client.destroy();
      process.exit(0);
    }, 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await startAgent(client, controller.signal);
  await client.destroy();
}

main().catch((err) => {
  log.error('Fatal:', err?.stack ?? err?.message ?? err);
  process.exit(1);
});
