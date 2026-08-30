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
 *   node src/index.js --demo        offline escrow walk-through (real code, fake wallet), then exit
 */

import config from './config.js';
import { createLogger } from './logger.js';
import { SphereClient } from './sphere-client.js';

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
  // This is the AGENT's own key — never a candidate for OWNER_PUBKEY. The agent
  // never DMs itself, so its own key as owner would arm an admin surface nobody
  // can reach. OWNER_PUBKEY is the controlling identity's key, from elsewhere.
  log.info(`Pubkey   : ${client.identity.chainPubkey ?? '(n/a)'}  (this agent's own signing key)`);
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

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  banner();

  // Before the boot, deliberately: the walk-through drives the real state machine,
  // the real ledger and the real config over a FAKE wallet, so it must not open a
  // second Sphere connection on this identity. Unlike --whoami it is safe to run
  // while the service is up.
  if (args.has('--demo')) {
    const { runDemo } = await import('./demo.js');
    await runDemo({ pace: args.has('--fast') ? 0 : 900 });
    process.exit(0);
  }

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
