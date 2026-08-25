/**
 * frani-bounty — the autonomous loop
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * The long-running daemon. It keeps the board alive and reacting:
 *   • recovers any send interrupted by a crash (never resends — double-pay guard)
 *   • publishes the standing `service` advert so the board is discoverable
 *   • drains transfers/DMs that arrived while offline, then processes them
 *   • reacts to events: message:dm (commands), transfer:incoming (escrow funding,
 *     top-ups, tips), payment_request:incoming (declined — nobody pulls FROM escrow)
 *   • wakes on a slow timer to sweep bounties (fund/claim/confirm windows, expiries,
 *     due-soon reminders), re-assert the service intent, and optionally broadcast
 *   • runs a receive() safety-net poll so nothing is missed if an event is dropped
 *
 * Everything is event-driven or slow-polled with awaited, non-overlapping passes
 * — no busy loops, tiny CPU/RAM footprint. The loop unwinds cleanly on abort.
 */

import { coinIdsMatch } from '@unicitylabs/sphere-sdk';

import config from './config.js';
import { createLogger } from './logger.js';
import { State, normalizeKey, TERMINAL_STATUSES } from './state.js';
import { RateLimiter } from './ratelimit.js';
import bounty from './bounty.js';
import { handleDm } from './services/commands.js';
import { ensureServiceIntent, broadcastHeartbeat } from './services/delivery.js';

const log = createLogger('agent');

/**
 * Run `fn` every `ms`, non-overlapping (awaits each run before scheduling the
 * next), stopping cleanly on abort. Timers are NOT unref'd — they keep the
 * process alive for the lifetime of the loop.
 */
function every(ms, fn, signal, label) {
  let timer = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const tick = async () => {
    if (stopped || signal.aborted) return;
    try {
      await fn();
    } catch (err) {
      log.error(`[${label}] pass error: ${err?.stack ?? err?.message ?? err}`);
    }
    if (stopped || signal.aborted) return;
    timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  signal.addEventListener('abort', stop, { once: true });
  return stop;
}

/** Sum the UCT value (base units) of an incoming transfer. */
function uctAmount(client, transfer) {
  return (transfer.tokens ?? [])
    .filter((t) => coinIdsMatch(t.coinId, client.coin.coinId))
    .reduce((acc, t) => acc + BigInt(t.amount ?? '0'), 0n);
}

export async function startAgent(client, signal) {
  const state = State.load();
  client.attachState(state); // the client keeps the lag-free book balance in state
  const rateLimit = new RateLimiter();
  const sym = client.coin.symbol;
  const selfNorm = new Set([...client.selfPubkeys()].map(normalizeKey));
  const t = config.bounty;

  const balance = await client.effectiveSpendableWhole(); // anchors/reconciles the book to chain

  // Crash-safety: heal any release/refund caught mid-flight by a previous shutdown.
  await bounty.reconcileInterrupted(client, state, rateLimit);

  const held = state.bountiesWhere((b) => !TERMINAL_STATUSES.has(b.status)).length;
  log.info('──────────────────────────────────────────────');
  log.info(' frani-bounty — services starting');
  log.info(`   identity   : ${client.describe()}`);
  log.info(`   spendable  : ${balance} ${sym}  ·  in escrow ${client.fmt(state.escrowedTotalBase())} across ${held} bounty(ies)`);
  log.info(`   outflow    : ${config.safety.releaseEnabled && !state.paused ? 'LIVE' : 'PAUSED'} · fee ${t.feeBps / 100}% on release · refunds always full`);
  log.info(`   reward     : ${t.minRewardWhole}–${t.maxRewardWhole} ${sym} · global custody cap ${t.maxTotalEscrowWhole} ${sym}`);
  log.info(`   windows    : fund ${t.fundWindowHours}h · claim ${t.claimWindowHours}h · confirm ${t.confirmWindowHours}h · open ${t.openExpiryDays}d`);
  log.info(`   dispute    : confirm-timeout → ${config.safety.autoReleaseOnConfirmTimeout ? 'AUTO-RELEASE to worker' : 'escalate to owner'}`);
  log.info(`   cadence    : sweep every ${Math.round(config.schedule.sweepMs / 60_000)}m · receive net ${Math.round(config.schedule.receivePollMs / 1000)}s`);
  log.info(`   admin      : ${config.admin.enabled ? 'enabled (owner DM)' : 'disabled (no OWNER_PUBKEY)'} · dry-run ${config.safety.dryRun}`);
  log.info(`   lifetime   : ${state.stats.bountiesCreated} created · ${state.stats.bountiesReleased} released · ${state.stats.bountiesRefunded} refunded`);
  log.info('──────────────────────────────────────────────');

  // ── event handlers ──────────────────────────────────────────────────────────
  async function onTransfer(transfer) {
    if (signal.aborted || !transfer?.id) return;
    if (!state.markTransferSeen(transfer.id)) return; // relay / receive() double-delivery
    state.save();
    if (selfNorm.has(normalizeKey(transfer.senderPubkey))) return; // ignore our own change/outputs
    const amountBase = uctAmount(client, transfer);
    if (amountBase <= 0n) return; // non-UCT or empty transfer
    try {
      await bounty.applyIncomingFunds(client, state, rateLimit, {
        senderPubkey: transfer.senderPubkey,
        senderNametag: transfer.senderNametag,
        amountBase,
      });
    } catch (err) {
      log.error(`transfer handler error: ${err?.stack ?? err?.message ?? err}`);
    }
  }

  async function onDm(dm) {
    if (signal.aborted || !dm?.id) return;
    if (selfNorm.has(normalizeKey(dm.senderPubkey))) return; // never talk to ourselves
    if (!state.markDmSeen(dm.id)) return; // dedup replays → at-most-once handling
    state.save();
    try {
      await handleDm(client, state, rateLimit, dm);
    } catch (err) {
      log.error(`dm handler error: ${err?.stack ?? err?.message ?? err}`);
    }
  }

  async function onPaymentRequest(pr) {
    if (signal.aborted || !pr?.id) return;
    if (!state.markPaymentReqSeen(pr.id)) return;
    state.save();
    const who = pr.senderNametag ? `@${pr.senderNametag}` : pr.senderPubkey;
    // The board's balance is other people's escrow — nobody may pull funds FROM it.
    // Funding always flows the other way (a transfer TO the board, or approving the
    // board's OWN request). So an inbound request to us is always declined.
    log.info(`Incoming payment request from ${who} — declining (the board never pays arbitrary requests).`);
    await client.declineInbound(pr.id);
  }

  async function drainIncoming(why) {
    try {
      const { transfers } = await client.sphere.payments.receive();
      if (transfers?.length) log.info(`receive() surfaced ${transfers.length} transfer(s) [${why}].`);
      for (const tr of transfers ?? []) await onTransfer(tr);
    } catch (err) {
      log.warn(`receive() failed [${why}]: ${err?.message ?? err}`);
    }
  }

  // ── periodic sweep: bounties + intent + heartbeat ────────────────────────────
  async function sweep(why) {
    if (signal.aborted) return;
    try {
      const s = await bounty.sweep(client, state, rateLimit, Date.now());
      if (s.expired || s.reopened || s.autoReleased || s.reminders) {
        log.info(`sweep [${why}]: ${s.expired} expired, ${s.reopened} reopened, ${s.autoReleased} auto-released, ${s.reminders} reminder(s).`);
      }
    } catch (err) {
      log.error(`bounty sweep error [${why}]: ${err?.stack ?? err?.message ?? err}`);
    }
    await ensureServiceIntent(client, state); // re-assert if it expired
    try {
      await broadcastHeartbeat(client, state, rateLimit);
    } catch (err) {
      log.warn(`heartbeat error: ${err?.message ?? err}`);
    }
  }

  // ── 1) advertise ─────────────────────────────────────────────────────────────
  await ensureServiceIntent(client, state);

  // ── 2) process anything that landed while we were offline ────────────────────
  await drainIncoming('startup');

  // ── 3) subscribe to live events ──────────────────────────────────────────────
  const unsubs = [];
  try {
    unsubs.push(client.sphere.on('transfer:incoming', (tr) => void onTransfer(tr)));
    unsubs.push(client.sphere.on('message:dm', (dm) => void onDm(dm)));
    unsubs.push(client.sphere.on('payment_request:incoming', (pr) => void onPaymentRequest(pr)));
    log.info('Subscribed to transfer / DM / payment-request events.');
  } catch (err) {
    log.warn(`Event subscription issue: ${err?.message ?? err}`);
  }

  // ── 4) periodic passes: bounty sweep + receive safety-net ────────────────────
  const stopSweep = every(config.schedule.sweepMs, () => sweep('tick'), signal, 'sweep');
  const stopReceive = every(config.schedule.receivePollMs, () => drainIncoming('poll'), signal, 'receive');

  // First sweep shortly after boot (catch windows that elapsed while offline).
  const bootSweep = setTimeout(() => void sweep('startup'), 3000);

  log.info('frani-bounty is live. Ctrl-C to stop.');

  // ── stay alive until aborted, then unwind ────────────────────────────────────
  await new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

  log.info('Stopping services…');
  clearTimeout(bootSweep);
  stopSweep();
  stopReceive();
  for (const u of unsubs) {
    try {
      u?.();
    } catch {
      /* ignore */
    }
  }
  state.save();
  log.info('Services stopped; state persisted.');
}

export default startAgent;
