/**
 * frani-bounty — the escrow state machine & money moves
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * This is the board's brain. Every transition a bounty can make lives here, and
 * every UCT that leaves the wallet leaves through `releaseBounty` / `refundBounty`
 * below — never from anywhere else. The design goals, in order:
 *
 *   1. Custody is sacred. The board holds posters' reward funds. It only ever pays
 *      them out (a) to the confirmed claimer on a release, minus the protocol fee,
 *      or (b) back to the poster in full on a refund. The guarded send in
 *      sphere-client re-checks, independently of anything here, that a payout can
 *      never dip into the escrow still owed to OTHER bounties (co-mingling guard).
 *
 *   2. Crash-safety. Before any send we persist an interim RELEASING / REFUNDING
 *      status plus the exact amount in flight. If we die mid-send, boot recovery
 *      (`reconcileInterrupted`) marks the bounty done-but-unconfirmed and NEVER
 *      resends (double-pay guard) — it flags the owner to eyeball the wallet.
 *
 *   3. Honesty over optimism. A send that we can't confirm is recorded as done
 *      "(network confirmation pending)" and the counterparty is told the truth —
 *      we never claim a payout landed when we don't know, and never claim nothing
 *      happened when the burn may already be certified.
 *
 *   4. Everyone gets generous, announced time. Auto-resolution (expiry, claim
 *      lapse, confirm-timeout auto-release) is always preceded by a reminder and a
 *      clearly-stated deadline. The configured dispute policy on a silent poster is
 *      to auto-release to the worker who did the work.
 */

import config from './config.js';
import { createLogger } from './logger.js';
import { feeOf } from './money.js';
import { reply, recipientFromSender, sig } from './reply.js';
import { STATUS, TERMINAL_STATUSES, normalizeKey } from './state.js';

const log = createLogger('bounty');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_TITLE = 140;
const MAX_PROOF = 600;

// ── formatting helpers ────────────────────────────────────────────────────────
function fmtWhen(ms) {
  if (!ms) return 'n/a';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Human "time remaining" until a future timestamp. */
function fmtLeft(target, now) {
  let s = Math.max(0, Math.floor((target - now) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (!d && m) parts.push(`${m}m`);
  return parts.length ? parts.join(' ') : '<1m';
}

/** Fee + net payout for a bounty's current reward, using its snapshot fee rate. */
function feeInfo(b) {
  const reward = BigInt(b.rewardBase);
  let fee = feeOf(reward, b.feeBps ?? config.bounty.feeBps);
  let payout = reward - fee;
  if (payout <= 0n) {
    // Degenerate (reward smaller than a fee unit): never pay the worker nothing.
    fee = 0n;
    payout = reward;
  }
  return { reward, fee, payout };
}

// ── display helpers (used by the command router's list/view/status) ───────────
/** One-line summary of a bounty. */
export function summarizeBounty(client, b) {
  const who = b.claimerNametag ? ` · @${b.claimerNametag}` : b.claimer ? ' · claimed' : '';
  const title = b.title ? ` · "${b.title}"` : '';
  return `#${b.id} · ${b.status} · ${client.fmt(b.rewardBase)}${who}${title}`;
}

/** Multi-line detail for `view <id>`. */
export function describeBounty(client, b, now = Date.now()) {
  const { fee, payout } = feeInfo(b);
  const lines = [
    `Bounty #${b.id} — ${b.status.toUpperCase()}`,
    b.title ? `Title: "${b.title}"` : null,
    `Reward (escrow): ${client.fmt(b.rewardBase)}`,
    `Worker receives: ${client.fmt(payout)}  (protocol fee ${client.fmt(fee)}, ${(b.feeBps ?? config.bounty.feeBps) / 100}%)`,
    b.posterNametag ? `Poster: @${b.posterNametag}` : null,
    b.claimerNametag ? `Claimed by: @${b.claimerNametag}` : b.claimer ? 'Claimed by: (a worker)' : null,
  ];
  if (b.status === STATUS.DRAFT) {
    lines.push(`Funded so far: ${client.fmt(b.fundedBase)} of ${client.fmt(b.rewardBase)}`);
    if (b.fundDeadline) lines.push(`Fund by: ${fmtWhen(b.fundDeadline)} (in ${fmtLeft(b.fundDeadline, now)})`);
  } else if (b.status === STATUS.OPEN) {
    if (b.openExpiryAt) lines.push(`Expires if unclaimed: ${fmtWhen(b.openExpiryAt)}`);
  } else if (b.status === STATUS.CLAIMED) {
    if (b.claimDeadline) lines.push(`Proof due: ${fmtWhen(b.claimDeadline)} (in ${fmtLeft(b.claimDeadline, now)})`);
  } else if (b.status === STATUS.SUBMITTED) {
    if (b.proof?.text) lines.push(`Proof: "${b.proof.text}"`);
    if (b.confirmDeadline) lines.push(`Auto-releases: ${fmtWhen(b.confirmDeadline)} (in ${fmtLeft(b.confirmDeadline, now)})`);
  }
  if (b.releaseUnconfirmed) lines.push('⚠︎ payout sent but network confirmation is pending');
  if (b.refundUnconfirmed) lines.push('⚠︎ refund sent but network confirmation is pending');
  return lines.filter(Boolean).join('\n');
}

// ── ledger helper ─────────────────────────────────────────────────────────────
function record(state, kind, b, extra = {}) {
  state.appendLedger({
    kind,
    bountyId: b?.id ?? null,
    poster: b?.poster ?? null,
    claimer: b?.claimer ?? null,
    status: b?.status ?? null,
    at: Date.now(),
    ...extra,
  });
}

// ── core money move: RELEASE reward to the claimer ────────────────────────────
/**
 * Pay the reward (minus fee) to a bounty's confirmed claimer. Persists a RELEASING
 * marker + the exact payout before the send so a crash can be recovered without a
 * double-pay. The fee stays in the wallet as accrued, withdrawable earnings.
 */
async function releaseBounty(client, state, rateLimit, b, { byTimeout = false, byOwner = false } = {}) {
  if (!b.claimer || !b.claimerRecipient) {
    log.warn(`Cannot release #${b.id}: no claimer on record.`);
    return { ok: false, reason: 'no-claimer' };
  }
  // Owner runtime freeze (DM `pause`): hold all outflow without a redeploy.
  if (state.paused) {
    log.warn(`Board is paused — holding release for #${b.id}.`);
    await reply(client, b.claimerRecipient, rateLimit, `Payouts are paused by the operator right now. Your reward for #${b.id} is safe in escrow and will pay out once resumed. ${sig()}`, { priority: true });
    return { ok: false, held: true, skipped: 'paused' };
  }
  // Bound the NUMBER of outbound payouts per hour (rate, not amount).
  if (!rateLimit.allow('release', config.safety.maxReleasesPerHour)) {
    log.warn(`Release rate cap reached — deferring payout for #${b.id}.`);
    return { ok: false, deferred: true };
  }

  const { fee, payout } = feeInfo(b);
  const keepFloorBase = state.escrowedTotalBase(b.id); // escrow owed to OTHER bounties
  const prior = b.status;
  const now = Date.now();

  // Persist the crash-safety marker + the exact amount in flight BEFORE the send.
  b.status = STATUS.RELEASING;
  b.releasingBase = payout.toString();
  b.releasingFeeBase = fee.toString();
  b.updatedAt = now;
  state.putBounty(b);
  state.save();

  const memo = `frani-bounty reward #${b.id}`;
  const res = await client.release(b.claimerRecipient, payout, memo, keepFloorBase);

  // Outflow paused, or the co-mingling guard tripped: revert & hold, funds untouched.
  if (res?.skipped === 'release-disabled' || res?.skipped === 'escrow-protect' || res?.skipped === 'non-positive amount') {
    b.status = prior;
    delete b.releasingBase;
    delete b.releasingFeeBase;
    state.putBounty(b);
    state.save();
    if (res.skipped === 'escrow-protect') {
      log.error(`Release of #${b.id} hit the escrow-protection floor — this should not happen; holding.`);
    }
    const why =
      res.skipped === 'release-disabled'
        ? 'Payouts are paused by the operator right now'
        : 'The board is briefly protecting other escrow';
    await reply(client, b.claimerRecipient, rateLimit, `${why}. Your reward for #${b.id} is safe in escrow and will pay out shortly. ${sig()}`, { priority: true });
    await notifyOwner(client, state, rateLimit, `Release of #${b.id} held (${res.skipped}); reward safe in escrow.`);
    return { ok: false, held: true, skipped: res.skipped };
  }

  // Mark done. On an ambiguous send we cannot know if the burn certified, so we
  // record it as released-but-unconfirmed and tell the claimer the plain truth.
  const unconfirmed = res?.ambiguous === true;
  const dry = res?.dryRun === true;
  b.status = STATUS.RELEASED;
  b.releaseUnconfirmed = unconfirmed;
  b.resolvedAt = now;
  b.outcome = { kind: 'released', byTimeout, byOwner, unconfirmed, dry };
  delete b.releasingBase;
  delete b.releasingFeeBase;
  state.putBounty(b);

  state.bumpStat('bountiesReleased');
  state.addStatBase('releasedBase', payout);
  state.addStatBase('feesLifetimeBase', fee);
  state.addSweepable(fee); // the fee remained in the wallet → withdrawable earnings
  record(state, 'release', b, {
    party: b.claimer,
    amountBase: payout.toString(),
    feeBase: fee.toString(),
    unconfirmed,
    note: dry ? '[dry-run]' : byTimeout ? 'auto-release (confirm timeout)' : byOwner ? 'operator resolve' : 'poster confirmed',
  });
  state.save();

  const reason = byTimeout ? ' (auto-released — the confirmation window elapsed)' : byOwner ? ' (released by the operator)' : '';
  if (unconfirmed) {
    await reply(client, b.claimerRecipient, rateLimit, `Reward for #${b.id}${reason}: I sent ${client.fmt(payout)} but couldn't get network confirmation. It may already be in your wallet; if it isn't shortly, contact the operator — I will NOT resend (double-pay guard). ${sig()}`, { priority: true });
    await reply(client, b.posterRecipient, rateLimit, `Bounty #${b.id} released to the worker (network confirmation pending). ${sig()}`, { priority: true });
    await notifyOwner(client, state, rateLimit, `⚠︎ #${b.id} released ${client.fmt(payout)} UNCONFIRMED — verify against the wallet.`);
  } else {
    await reply(client, b.claimerRecipient, rateLimit, `🎉 Reward released for #${b.id}${reason}: ${client.fmt(payout)} is on its way to you (protocol fee ${client.fmt(fee)}). Thanks for the work! ${sig()}`, { priority: true });
    await reply(client, b.posterRecipient, rateLimit, `Bounty #${b.id} confirmed & released to the worker (${client.fmt(payout)} paid, ${client.fmt(fee)} fee). Thanks for using the board. ${sig()}`, { priority: true });
  }
  return { ok: true, unconfirmed, dry };
}

// ── core money move: REFUND funds to the poster (always full, no fee) ─────────
async function refundBounty(client, state, rateLimit, b, { kind = 'refunded', reason = '' } = {}) {
  const terminal =
    kind === 'cancelled' ? STATUS.CANCELLED : kind === 'expired' ? STATUS.EXPIRED : STATUS.REFUNDED;
  const amountBase = state.heldBase(b);
  const now = Date.now();

  // Nothing is actually held (e.g. an unfunded draft) → just close it out.
  if (amountBase <= 0n) {
    b.status = terminal;
    b.resolvedAt = now;
    b.outcome = { kind, reason, amountBase: '0' };
    state.putBounty(b);
    state.bumpStat(kind === 'expired' ? 'bountiesExpired' : kind === 'cancelled' ? 'bountiesCancelled' : 'bountiesRefunded');
    record(state, kind === 'expired' ? 'expire' : 'cancel', b, { amountBase: '0', note: reason || 'nothing funded' });
    state.save();
    return { ok: true, nothing: true };
  }

  // Owner runtime freeze (DM `pause`): hold the refund without a redeploy.
  if (state.paused) {
    log.warn(`Board is paused — holding refund for #${b.id}.`);
    await reply(client, b.posterRecipient, rateLimit, `Refunds are paused by the operator right now. Your ${client.fmt(amountBase)} on #${b.id} is safe and will be returned once resumed. ${sig()}`, { priority: true });
    return { ok: false, held: true, skipped: 'paused' };
  }

  if (!rateLimit.allow('release', config.safety.maxReleasesPerHour)) {
    log.warn(`Release rate cap reached — deferring refund for #${b.id}.`);
    return { ok: false, deferred: true };
  }

  const keepFloorBase = state.escrowedTotalBase(b.id);
  const prior = b.status;
  b.status = STATUS.REFUNDING;
  b.refundingBase = amountBase.toString();
  b.updatedAt = now;
  state.putBounty(b);
  state.save();

  const memo = `frani-bounty refund #${b.id}`;
  const res = await client.refund(b.posterRecipient, amountBase, memo, keepFloorBase);

  if (res?.skipped === 'release-disabled' || res?.skipped === 'escrow-protect' || res?.skipped === 'non-positive amount') {
    b.status = prior;
    delete b.refundingBase;
    state.putBounty(b);
    state.save();
    const why = res.skipped === 'release-disabled' ? 'Refunds are paused by the operator right now' : 'The board is briefly protecting other escrow';
    await reply(client, b.posterRecipient, rateLimit, `${why}. Your ${client.fmt(amountBase)} on #${b.id} is safe and will be returned shortly. ${sig()}`, { priority: true });
    return { ok: false, held: true, skipped: res.skipped };
  }

  const unconfirmed = res?.ambiguous === true;
  const dry = res?.dryRun === true;
  b.status = terminal;
  b.refundUnconfirmed = unconfirmed;
  b.resolvedAt = now;
  b.outcome = { kind, reason, amountBase: amountBase.toString(), unconfirmed, dry };
  delete b.refundingBase;
  state.putBounty(b);

  state.bumpStat('bountiesRefunded');
  if (kind === 'expired') state.bumpStat('bountiesExpired');
  if (kind === 'cancelled') state.bumpStat('bountiesCancelled');
  state.addStatBase('refundedBase', amountBase);
  record(state, kind === 'expired' ? 'expire' : kind === 'cancelled' ? 'cancel' : 'refund', b, {
    party: b.poster,
    amountBase: amountBase.toString(),
    unconfirmed,
    note: dry ? '[dry-run]' : reason,
  });
  state.save();

  const label = kind === 'expired' ? 'expired' : kind === 'cancelled' ? 'cancelled' : 'refunded';
  if (unconfirmed) {
    await reply(client, b.posterRecipient, rateLimit, `Bounty #${b.id} ${label}: I sent your ${client.fmt(amountBase)} refund but couldn't confirm it on-network. If it isn't in your wallet shortly, contact the operator — I will NOT resend. ${sig()}`, { priority: true });
    await notifyOwner(client, state, rateLimit, `⚠︎ #${b.id} refund ${client.fmt(amountBase)} UNCONFIRMED — verify against the wallet.`);
  } else {
    await reply(client, b.posterRecipient, rateLimit, `Bounty #${b.id} ${label}${reason ? ` (${reason})` : ''}: ${client.fmt(amountBase)} returned to you in full. ${sig()}`, { priority: true });
  }
  return { ok: true, unconfirmed, dry };
}

/** Best-effort owner heads-up (only if an admin key is configured). */
async function notifyOwner(client, state, rateLimit, text) {
  if (!config.admin.enabled) return;
  try {
    await reply(client, config.admin.ownerPubkey, rateLimit, `[frani-bounty] ${text}`, { priority: true });
  } catch {
    /* owner notify is best-effort */
  }
}

// ── public lifecycle: CREATE ──────────────────────────────────────────────────
export async function createBounty(client, state, rateLimit, { dm, rewardWhole, title }) {
  const recipient = recipientFromSender(dm.senderPubkey, dm.senderNametag);
  const posterKey = normalizeKey(dm.senderPubkey);

  if (state.isBlacklisted(dm.senderPubkey)) {
    await reply(client, recipient, rateLimit, `Your account is blocked from posting bounties. ${sig()}`);
    return { ok: false };
  }

  const rewardBase = client.toBase(rewardWhole);
  const minBase = client.toBase(config.bounty.minRewardWhole);
  const maxBase = client.toBase(config.bounty.maxRewardWhole);
  if (rewardBase < minBase || rewardBase > maxBase) {
    await reply(client, recipient, rateLimit, `Reward must be between ${config.bounty.minRewardWhole} and ${config.bounty.maxRewardWhole} ${client.coin.symbol}. ${sig()}`);
    return { ok: false };
  }

  const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  if (!cleanTitle) {
    await reply(client, recipient, rateLimit, `Please add a short title: \`create <reward> <what needs doing>\`. ${sig()}`);
    return { ok: false };
  }

  if (state.countOpenLikeForPoster(posterKey) >= config.bounty.maxOpenBountiesPerPoster) {
    await reply(client, recipient, rateLimit, `You already have ${config.bounty.maxOpenBountiesPerPoster} active bounties (the per-poster limit). Resolve or cancel one first. ${sig()}`);
    return { ok: false };
  }

  const capBase = client.toBase(config.bounty.maxTotalEscrowWhole);
  if (state.committedTotalBase() + rewardBase > capBase) {
    await reply(client, recipient, rateLimit, `The board is near its custody ceiling (${config.bounty.maxTotalEscrowWhole} ${client.coin.symbol} total). Try a smaller reward or post again later. ${sig()}`);
    return { ok: false };
  }

  const now = Date.now();
  const id = state.newBountyId();
  const fee = feeOf(rewardBase, config.bounty.feeBps);
  const payout = rewardBase - fee;
  const b = {
    id,
    poster: posterKey,
    posterRecipient: recipient,
    posterNametag: dm.senderNametag || null,
    claimer: null,
    claimerRecipient: null,
    claimerNametag: null,
    rewardBase: rewardBase.toString(),
    fundedBase: '0',
    feeBps: config.bounty.feeBps,
    title: cleanTitle,
    status: STATUS.DRAFT,
    proof: null,
    proofAttempts: 0,
    paymentRequestId: null,
    createdAt: now,
    updatedAt: now,
    fundDeadline: now + config.bounty.fundWindowHours * HOUR_MS,
    fundedAt: null,
    claimedAt: null,
    submittedAt: null,
    resolvedAt: null,
    claimDeadline: null,
    confirmDeadline: null,
    openExpiryAt: null,
    reminders: {},
    releaseUnconfirmed: false,
    refundUnconfirmed: false,
    outcome: null,
  };
  state.putBounty(b);
  state.bumpStat('bountiesCreated');
  record(state, 'create', b, { amountBase: rewardBase.toString() });
  state.save();

  // Send the escrow-funding invoice (best-effort; the poster can also just send UCT).
  const pr = await client.requestPayment(recipient, rewardWhole, `Fund bounty #${id}: ${cleanTitle}`);
  if (pr?.success && pr?.id) {
    b.paymentRequestId = pr.id;
    state.putBounty(b);
    state.save();
  }

  await reply(
    client,
    recipient,
    rateLimit,
    [
      `Bounty #${id} created ✅`,
      `Title: "${cleanTitle}"`,
      `Reward in escrow: ${client.fmt(rewardBase)} → the worker receives ${client.fmt(payout)} (${config.bounty.feeBps / 100}% protocol fee, taken only on release).`,
      ``,
      `To fund it: approve the payment request I just sent, or send ${rewardWhole} ${client.coin.symbol} to @${config.nametag}.`,
      `Fund by ${fmtWhen(b.fundDeadline)} (in ${fmtLeft(b.fundDeadline, now)}) or it auto-expires and any funds return to you.`,
      `Once funded it goes live for workers to \`claim ${id}\`.`,
      sig(),
    ].join('\n'),
    { priority: true },
  );
  return { ok: true, id };
}

// ── public lifecycle: incoming funds (escrow funding, top-ups, tips) ──────────
/**
 * Route an incoming transfer. Matching order: the sender's oldest unfunded draft
 * (accumulate → flip to OPEN at full funding, overpay becomes a tip); else a
 * pending add-reward top-up; else it's a tip to the board. Incoming funds are NOT
 * credited to the book here — the quiescent reconcile heals the book upward once
 * settled, keeping the outflow guard conservative in the meantime.
 */
export async function applyIncomingFunds(client, state, rateLimit, { senderPubkey, senderNametag, amountBase }) {
  const amount = BigInt(amountBase);
  if (amount <= 0n) return { matched: 'none' };
  const key = normalizeKey(senderPubkey);
  const recipient = recipientFromSender(senderPubkey, senderNametag);
  const now = Date.now();

  // (A) Fund the sender's oldest unfunded draft.
  const drafts = state.unfundedDraftsByPoster(key);
  if (drafts.length) {
    const d = drafts[0];
    const reward = BigInt(d.rewardBase);
    d.fundedBase = (BigInt(d.fundedBase) + amount).toString();
    d.updatedAt = now;

    if (BigInt(d.fundedBase) >= reward) {
      const excess = BigInt(d.fundedBase) - reward;
      d.fundedBase = reward.toString(); // escrow exactly the reward
      d.status = STATUS.OPEN;
      d.fundedAt = now;
      d.openExpiryAt = now + config.bounty.openExpiryDays * DAY_MS;
      state.putBounty(d);
      state.bumpStat('bountiesFunded');
      record(state, 'funded', d, { party: key, amountBase: amount.toString() });

      if (excess > 0n) {
        state.addSweepable(excess);
        state.addStatBase('tipsLifetimeBase', excess);
        record(state, 'tip', d, { party: key, amountBase: excess.toString(), note: 'funding overpay' });
      }
      state.save();

      await reply(client, recipient, rateLimit, `Bounty #${d.id} is funded and LIVE 🎉 — ${client.fmt(reward)} in escrow. Workers can now \`claim ${d.id}\`.${excess > 0n ? ` (You sent ${client.fmt(excess)} over the reward — kept as a tip to the board, thank you!)` : ''} ${sig()}`, { priority: true });
      return { matched: 'draft-funded', id: d.id };
    }

    // Partial funding — keep accumulating.
    state.putBounty(d);
    record(state, 'fund-partial', d, { party: key, amountBase: amount.toString() });
    state.save();
    const remaining = reward - BigInt(d.fundedBase);
    await reply(client, recipient, rateLimit, `Received ${client.fmt(amount)} toward #${d.id} (${client.fmt(d.fundedBase)} of ${client.fmt(reward)}). ${client.fmt(remaining)} to go — send it before ${fmtWhen(d.fundDeadline)} to make it live. ${sig()}`, { priority: true });
    return { matched: 'draft-partial', id: d.id };
  }

  // (B) A pending add-reward top-up from this sender.
  const topup = state.getPendingTopup(key);
  if (topup) {
    const b = state.getBounty(topup.bountyId);
    if (b && (b.status === STATUS.OPEN || b.status === STATUS.CLAIMED || b.status === STATUS.SUBMITTED)) {
      b.rewardBase = (BigInt(b.rewardBase) + amount).toString();
      b.updatedAt = now;
      state.putBounty(b);
      state.clearPendingTopup(key);
      record(state, 'topup', b, { party: key, amountBase: amount.toString() });
      state.save();

      await reply(client, recipient, rateLimit, `Added ${client.fmt(amount)} to #${b.id} — reward is now ${client.fmt(b.rewardBase)}. ${sig()}`, { priority: true });
      if (b.poster !== key) await reply(client, b.posterRecipient, rateLimit, `Your bounty #${b.id} was boosted; reward is now ${client.fmt(b.rewardBase)}. ${sig()}`, { priority: true });
      if (b.claimerRecipient) await reply(client, b.claimerRecipient, rateLimit, `The reward on #${b.id} rose to ${client.fmt(b.rewardBase)}. ${sig()}`, { priority: true });
      return { matched: 'topup', id: b.id };
    }
    state.clearPendingTopup(key); // target vanished → fall through to a tip
    state.save();
  }

  // (C) Unattributed funds → a tip to the board.
  state.addSweepable(amount);
  state.addStatBase('tipsLifetimeBase', amount);
  record(state, 'tip', null, { party: key, amountBase: amount.toString() });
  state.save();
  await reply(client, recipient, rateLimit, `Thanks for the ${client.fmt(amount)} tip! 🙏 To post a bounty, DM \`create <reward> <what needs doing>\`. ${sig()}`, { priority: true });
  return { matched: 'tip' };
}

// ── public lifecycle: CLAIM ───────────────────────────────────────────────────
export async function claimBounty(client, state, rateLimit, { dm, bountyId }) {
  const recipient = recipientFromSender(dm.senderPubkey, dm.senderNametag);
  const claimerKey = normalizeKey(dm.senderPubkey);
  const b = state.getBounty(bountyId);
  if (!b) {
    await reply(client, recipient, rateLimit, `No bounty #${bountyId}. Try \`list\` to see what's open. ${sig()}`);
    return { ok: false };
  }
  if (state.isBlacklisted(dm.senderPubkey)) {
    await reply(client, recipient, rateLimit, `Your account is blocked from claiming. ${sig()}`);
    return { ok: false };
  }
  if (b.status !== STATUS.OPEN) {
    await reply(client, recipient, rateLimit, `Bounty #${b.id} is ${b.status}, not open to claim. ${sig()}`);
    return { ok: false };
  }
  if (claimerKey === b.poster) {
    await reply(client, recipient, rateLimit, `You can't claim your own bounty #${b.id}. ${sig()}`);
    return { ok: false };
  }
  if (state.countActiveClaimsForClaimer(claimerKey) >= config.bounty.maxActiveClaimsPerClaimer) {
    await reply(client, recipient, rateLimit, `You're at the max ${config.bounty.maxActiveClaimsPerClaimer} active claims. Finish or drop one first. ${sig()}`);
    return { ok: false };
  }

  const now = Date.now();
  b.claimer = claimerKey;
  b.claimerRecipient = recipient;
  b.claimerNametag = dm.senderNametag || null;
  b.status = STATUS.CLAIMED;
  b.claimedAt = now;
  b.claimDeadline = now + config.bounty.claimWindowHours * HOUR_MS;
  b.reminders = { ...b.reminders, claimSoon: false };
  b.updatedAt = now;
  state.putBounty(b);
  record(state, 'claim', b, { party: claimerKey });
  state.save();

  await reply(client, recipient, rateLimit, `You claimed #${b.id}: "${b.title}". Do the work, then \`submit ${b.id} <link or description>\` before ${fmtWhen(b.claimDeadline)} (in ${fmtLeft(b.claimDeadline, now)}). If you go quiet past then, the claim lapses and it reopens. ${sig()}`, { priority: true });
  await reply(client, b.posterRecipient, rateLimit, `Your bounty #${b.id} was claimed${b.claimerNametag ? ` by @${b.claimerNametag}` : ''}. You'll be asked to confirm once they submit proof. ${sig()}`, { priority: true });
  return { ok: true };
}

// ── public lifecycle: SUBMIT proof ────────────────────────────────────────────
export async function submitProof(client, state, rateLimit, { dm, bountyId, proof }) {
  const recipient = recipientFromSender(dm.senderPubkey, dm.senderNametag);
  const senderKey = normalizeKey(dm.senderPubkey);
  const b = state.getBounty(bountyId);
  if (!b) {
    await reply(client, recipient, rateLimit, `No bounty #${bountyId}. ${sig()}`);
    return { ok: false };
  }
  if (b.claimer !== senderKey) {
    await reply(client, recipient, rateLimit, `Only the claimer can submit proof for #${b.id}. ${sig()}`);
    return { ok: false };
  }
  if (b.status !== STATUS.CLAIMED && b.status !== STATUS.SUBMITTED) {
    await reply(client, recipient, rateLimit, `Bounty #${b.id} is ${b.status}; nothing to submit. ${sig()}`);
    return { ok: false };
  }
  const cleanProof = String(proof || '').replace(/\s+/g, ' ').trim().slice(0, MAX_PROOF);
  if (!cleanProof) {
    await reply(client, recipient, rateLimit, `Include your work: \`submit ${b.id} <link or description>\`. ${sig()}`);
    return { ok: false };
  }

  const now = Date.now();
  const fresh = b.status === STATUS.CLAIMED; // a first submission vs. a voluntary update
  b.proof = { text: cleanProof, at: now };
  b.status = STATUS.SUBMITTED;
  b.submittedAt = now;
  if (fresh) {
    b.proofAttempts = (b.proofAttempts ?? 0) + 1;
    b.confirmDeadline = now + config.bounty.confirmWindowHours * HOUR_MS;
    b.reminders = { ...b.reminders, confirmSoon: false };
  }
  b.updatedAt = now;
  state.putBounty(b);
  record(state, 'submit', b, { party: senderKey, note: fresh ? `attempt ${b.proofAttempts}` : 'updated proof' });
  state.save();

  const { fee, payout } = feeInfo(b);
  await reply(client, b.posterRecipient, rateLimit, [
    `Proof submitted for #${b.id}${b.claimerNametag ? ` by @${b.claimerNametag}` : ''}:`,
    `"${cleanProof}"`,
    ``,
    `\`confirm ${b.id}\` to release ${client.fmt(payout)} to the worker (fee ${client.fmt(fee)}), or \`reject ${b.id} [reason]\`.`,
    config.safety.autoReleaseOnConfirmTimeout
      ? `If you don't act by ${fmtWhen(b.confirmDeadline)}, it auto-releases to the worker.`
      : `Please act by ${fmtWhen(b.confirmDeadline)}.`,
    sig(),
  ].join('\n'), { priority: true });
  await reply(client, recipient, rateLimit, `Proof submitted for #${b.id}. Awaiting the poster's confirmation${config.safety.autoReleaseOnConfirmTimeout ? ` (auto-releases to you by ${fmtWhen(b.confirmDeadline)} if they're silent)` : ''}. ${sig()}`, { priority: true });
  return { ok: true };
}

// ── public lifecycle: CONFIRM (poster/owner) → release ────────────────────────
export async function confirmBounty(client, state, rateLimit, { dm, bountyId, byOwner = false }) {
  const recipient = recipientFromSender(dm.senderPubkey, dm.senderNametag);
  const senderKey = normalizeKey(dm.senderPubkey);
  const b = state.getBounty(bountyId);
  if (!b) {
    await reply(client, recipient, rateLimit, `No bounty #${bountyId}. ${sig()}`);
    return { ok: false };
  }
  if (!byOwner && senderKey !== b.poster) {
    await reply(client, recipient, rateLimit, `Only the poster can confirm #${b.id}. ${sig()}`);
    return { ok: false };
  }
  if (b.status !== STATUS.SUBMITTED) {
    await reply(client, recipient, rateLimit, `Bounty #${b.id} is ${b.status}; there's no submitted proof to confirm. ${sig()}`);
    return { ok: false };
  }
  const res = await releaseBounty(client, state, rateLimit, b, { byOwner });
  if (res.deferred) {
    await reply(client, recipient, rateLimit, `Confirmation received for #${b.id}; the release is queued and will process shortly. ${sig()}`, { priority: true });
  }
  return res;
}

// ── public lifecycle: REJECT proof (poster/owner) ─────────────────────────────
export async function rejectProof(client, state, rateLimit, { dm, bountyId, reason = '', byOwner = false }) {
  const recipient = recipientFromSender(dm.senderPubkey, dm.senderNametag);
  const senderKey = normalizeKey(dm.senderPubkey);
  const b = state.getBounty(bountyId);
  if (!b) {
    await reply(client, recipient, rateLimit, `No bounty #${bountyId}. ${sig()}`);
    return { ok: false };
  }
  if (!byOwner && senderKey !== b.poster) {
    await reply(client, recipient, rateLimit, `Only the poster can reject proof on #${b.id}. ${sig()}`);
    return { ok: false };
  }
  if (b.status !== STATUS.SUBMITTED) {
    await reply(client, recipient, rateLimit, `Bounty #${b.id} is ${b.status}; nothing to reject. ${sig()}`);
    return { ok: false };
  }

  const now = Date.now();
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const claimerRecipient = b.claimerRecipient;
  const atMax = (b.proofAttempts ?? 0) >= config.bounty.maxProofAttempts;

  if (atMax) {
    // Out of attempts → return the bounty to the open pool for someone else.
    b.status = STATUS.OPEN;
    b.claimer = null;
    b.claimerRecipient = null;
    b.claimerNametag = null;
    b.claimedAt = null;
    b.claimDeadline = null;
    b.submittedAt = null;
    b.confirmDeadline = null;
    b.proof = null;
    b.proofAttempts = 0;
    b.openExpiryAt = now + config.bounty.openExpiryDays * DAY_MS;
    b.reminders = {};
    b.updatedAt = now;
    state.putBounty(b);
    record(state, 'reject-reopen', b, { note: why || 'max attempts reached' });
    state.save();
    if (claimerRecipient) await reply(client, claimerRecipient, rateLimit, `Your proof for #${b.id} was rejected${why ? `: ${why}` : ''} and the attempt limit is reached. The bounty has reopened for others. ${sig()}`, { priority: true });
    await reply(client, recipient, rateLimit, `Rejected — #${b.id} has reopened to the pool. ${sig()}`, { priority: true });
    return { ok: true, reopened: true };
  }

  // Back to the claimer for a revision.
  b.status = STATUS.CLAIMED;
  b.submittedAt = null;
  b.confirmDeadline = null;
  b.proof = null;
  b.claimDeadline = now + config.bounty.claimWindowHours * HOUR_MS;
  b.reminders = { ...b.reminders, claimSoon: false };
  b.updatedAt = now;
  state.putBounty(b);
  record(state, 'reject', b, { note: why });
  state.save();
  if (claimerRecipient) await reply(client, claimerRecipient, rateLimit, `Your proof for #${b.id} was rejected${why ? `: ${why}` : ''}. You can revise and \`submit ${b.id} <proof>\` again before ${fmtWhen(b.claimDeadline)} (attempt ${b.proofAttempts}/${config.bounty.maxProofAttempts}). ${sig()}`, { priority: true });
  await reply(client, recipient, rateLimit, `You rejected the proof for #${b.id}; the worker can resubmit. ${sig()}`, { priority: true });
  return { ok: true };
}

// ── public lifecycle: CANCEL (poster/owner) ───────────────────────────────────
export async function cancelBounty(client, state, rateLimit, { dm, bountyId, byOwner = false }) {
  const recipient = recipientFromSender(dm.senderPubkey, dm.senderNametag);
  const senderKey = normalizeKey(dm.senderPubkey);
  const b = state.getBounty(bountyId);
  if (!b) {
    await reply(client, recipient, rateLimit, `No bounty #${bountyId}. ${sig()}`);
    return { ok: false };
  }
  if (!byOwner && senderKey !== b.poster) {
    await reply(client, recipient, rateLimit, `Only the poster can cancel #${b.id}. ${sig()}`);
    return { ok: false };
  }
  if (b.status !== STATUS.DRAFT && b.status !== STATUS.OPEN) {
    await reply(client, recipient, rateLimit, `Someone is working on #${b.id} (it's ${b.status}); it can't be cancelled now. It'll resolve via confirm/reject or auto-release. ${sig()}`);
    return { ok: false };
  }
  return refundBounty(client, state, rateLimit, b, { kind: 'cancelled', reason: 'cancelled by poster' });
}

// ── public lifecycle: ADD-REWARD / boost (anyone) ─────────────────────────────
export async function addReward(client, state, rateLimit, { dm, bountyId, amountWhole }) {
  const recipient = recipientFromSender(dm.senderPubkey, dm.senderNametag);
  const b = state.getBounty(bountyId);
  if (!b) {
    await reply(client, recipient, rateLimit, `No bounty #${bountyId}. ${sig()}`);
    return { ok: false };
  }
  if (state.isBlacklisted(dm.senderPubkey)) {
    await reply(client, recipient, rateLimit, `Your account is blocked. ${sig()}`);
    return { ok: false };
  }
  if (b.status !== STATUS.OPEN && b.status !== STATUS.CLAIMED && b.status !== STATUS.SUBMITTED) {
    await reply(client, recipient, rateLimit, `You can only boost a live bounty; #${b.id} is ${b.status}. ${sig()}`);
    return { ok: false };
  }
  const amountBase = client.toBase(amountWhole);
  const maxBase = client.toBase(config.bounty.maxRewardWhole);
  if (amountBase <= 0n || amountBase > maxBase) {
    await reply(client, recipient, rateLimit, `Boost amount must be between 0 and ${config.bounty.maxRewardWhole} ${client.coin.symbol}. ${sig()}`);
    return { ok: false };
  }

  state.setPendingTopup(dm.senderPubkey, b.id, amountBase);
  record(state, 'topup-intent', b, { party: normalizeKey(dm.senderPubkey), amountBase: amountBase.toString() });
  state.save();
  await client.requestPayment(recipient, amountWhole, `Boost bounty #${b.id}`);
  await reply(client, recipient, rateLimit, `To add ${amountWhole} ${client.coin.symbol} to #${b.id}, approve the payment request I just sent, or send it to @${config.nametag}. The reward rises when it arrives. ${sig()}`, { priority: true });
  return { ok: true };
}

// ── owner override: RESOLVE a dispute (release to claimer | refund to poster) ─
export async function ownerResolve(client, state, rateLimit, { dm, bountyId, action }) {
  const recipient = recipientFromSender(dm.senderPubkey, dm.senderNametag);
  const b = state.getBounty(bountyId);
  if (!b) {
    await reply(client, recipient, rateLimit, `No bounty #${bountyId}. ${sig()}`);
    return { ok: false };
  }
  if (TERMINAL_STATUSES.has(b.status)) {
    await reply(client, recipient, rateLimit, `Bounty #${b.id} is already ${b.status}. ${sig()}`);
    return { ok: false };
  }
  if (action === 'release') {
    if (!b.claimer) {
      await reply(client, recipient, rateLimit, `#${b.id} has no claimer to release to; use \`resolve ${b.id} refund\`. ${sig()}`);
      return { ok: false };
    }
    return releaseBounty(client, state, rateLimit, b, { byOwner: true });
  }
  if (action === 'refund') {
    return refundBounty(client, state, rateLimit, b, { kind: 'refunded', reason: 'operator resolve' });
  }
  await reply(client, recipient, rateLimit, `Usage: \`resolve <id> release|refund\`. ${sig()}`);
  return { ok: false };
}

// ── periodic sweep: expiries, timeouts, claim lapses, due-soon reminders ──────
export async function sweep(client, state, rateLimit, now = Date.now()) {
  const summary = { expired: 0, refunded: 0, reopened: 0, autoReleased: 0, reminders: 0 };
  let dirty = false;

  const canRemind = () => rateLimit.peek('dm', config.safety.maxDmsPerHour) && rateLimit.peek('action', config.safety.maxActionsPerHour);

  for (const b of state.allBounties()) {
    if (TERMINAL_STATUSES.has(b.status)) continue;
    if (b.status === STATUS.RELEASING || b.status === STATUS.REFUNDING) continue; // handled at boot

    // ── DRAFT: fund window ──────────────────────────────────────────────────
    if (b.status === STATUS.DRAFT) {
      if (now >= b.fundDeadline) {
        const res = await refundBounty(client, state, rateLimit, b, { kind: 'expired', reason: 'funding window elapsed' });
        if (res.ok) {
          summary.expired += 1;
          if (!res.nothing) summary.refunded += 1;
        }
        continue;
      }
      const windowMs = config.bounty.fundWindowHours * HOUR_MS;
      if (!b.reminders?.fundSoon && b.fundDeadline - now < windowMs * 0.25 && BigInt(b.fundedBase) < BigInt(b.rewardBase) && canRemind()) {
        b.reminders = { ...b.reminders, fundSoon: true };
        dirty = true;
        await reply(client, b.posterRecipient, rateLimit, `Reminder: fund #${b.id} before ${fmtWhen(b.fundDeadline)} or it expires (received ${client.fmt(b.fundedBase)} of ${client.fmt(b.rewardBase)}). ${sig()}`);
        summary.reminders += 1;
      }
      continue;
    }

    // ── OPEN: unclaimed expiry ──────────────────────────────────────────────
    if (b.status === STATUS.OPEN) {
      if (b.openExpiryAt && now >= b.openExpiryAt) {
        const res = await refundBounty(client, state, rateLimit, b, { kind: 'expired', reason: 'no claim before expiry' });
        if (res.ok) {
          summary.expired += 1;
          summary.refunded += 1;
        }
        continue;
      }
      if (b.openExpiryAt && !b.reminders?.expirySoon && b.openExpiryAt - now < DAY_MS && canRemind()) {
        b.reminders = { ...b.reminders, expirySoon: true };
        dirty = true;
        await reply(client, b.posterRecipient, rateLimit, `#${b.id} is still unclaimed and expires ${fmtWhen(b.openExpiryAt)}; the reward will return to you then. ${sig()}`);
        summary.reminders += 1;
      }
      continue;
    }

    // ── CLAIMED: proof window ───────────────────────────────────────────────
    if (b.status === STATUS.CLAIMED) {
      if (b.claimDeadline && now >= b.claimDeadline) {
        const claimerRecipient = b.claimerRecipient;
        b.status = STATUS.OPEN;
        b.claimer = null;
        b.claimerRecipient = null;
        b.claimerNametag = null;
        b.claimedAt = null;
        b.claimDeadline = null;
        b.proof = null;
        b.proofAttempts = 0;
        b.openExpiryAt = now + config.bounty.openExpiryDays * DAY_MS;
        b.reminders = {};
        b.updatedAt = now;
        state.putBounty(b);
        record(state, 'claim-lapse', b);
        dirty = true;
        summary.reopened += 1;
        if (claimerRecipient) await reply(client, claimerRecipient, rateLimit, `Your claim on #${b.id} lapsed (no proof in time); it has reopened for others. ${sig()}`, { priority: true });
        await reply(client, b.posterRecipient, rateLimit, `The claim on #${b.id} lapsed; it reopened to the pool. ${sig()}`, { priority: true });
        continue;
      }
      const windowMs = config.bounty.claimWindowHours * HOUR_MS;
      const soon = Math.min(12 * HOUR_MS, windowMs * 0.25);
      if (b.claimDeadline && !b.reminders?.claimSoon && b.claimDeadline - now < soon && canRemind()) {
        b.reminders = { ...b.reminders, claimSoon: true };
        dirty = true;
        if (b.claimerRecipient) await reply(client, b.claimerRecipient, rateLimit, `Reminder: submit proof for #${b.id} before ${fmtWhen(b.claimDeadline)} or your claim lapses. ${sig()}`);
        summary.reminders += 1;
      }
      continue;
    }

    // ── SUBMITTED: confirm window → auto-release (Q1 policy) or escalate ─────
    if (b.status === STATUS.SUBMITTED) {
      if (b.confirmDeadline && now >= b.confirmDeadline) {
        if (config.safety.autoReleaseOnConfirmTimeout) {
          const res = await releaseBounty(client, state, rateLimit, b, { byTimeout: true });
          if (res.ok) summary.autoReleased += 1;
        } else if (!b.reminders?.escalated) {
          b.reminders = { ...b.reminders, escalated: true };
          dirty = true;
          await reply(client, b.posterRecipient, rateLimit, `#${b.id} proof is unconfirmed past the window and auto-release is off. The operator will resolve it. ${sig()}`, { priority: true });
          await notifyOwner(client, state, rateLimit, `#${b.id} needs manual resolve (confirm-timeout, auto-release disabled).`);
        }
        continue;
      }
      if (b.confirmDeadline && !b.reminders?.confirmSoon && b.confirmDeadline - now < DAY_MS && canRemind()) {
        b.reminders = { ...b.reminders, confirmSoon: true };
        dirty = true;
        await reply(client, b.posterRecipient, rateLimit, `Reminder: \`confirm ${b.id}\` or \`reject ${b.id}\` before ${fmtWhen(b.confirmDeadline)}${config.safety.autoReleaseOnConfirmTimeout ? ', or it auto-releases to the worker' : ''}. ${sig()}`);
        summary.reminders += 1;
      }
      continue;
    }
  }

  if (dirty) state.save();
  return summary;
}

// ── boot recovery: an interrupted RELEASING / REFUNDING send ──────────────────
/**
 * On startup, heal any bounty caught mid-send by a crash. We do NOT resend (a
 * double-pay risk — the burn may already be certified); instead we mark it done
 * "unconfirmed", record it, and flag the owner to verify against the wallet. The
 * book balance was already debited before the send, so it stays consistent.
 */
export async function reconcileInterrupted(client, state, rateLimit) {
  const recovered = [];
  const now = Date.now();

  for (const b of state.allBounties()) {
    if (b.status === STATUS.RELEASING) {
      const payout = BigInt(b.releasingBase ?? '0');
      const fee = BigInt(b.releasingFeeBase ?? '0');
      b.status = STATUS.RELEASED;
      b.releaseUnconfirmed = true;
      b.resolvedAt = now;
      b.outcome = { kind: 'released', recovered: true, unconfirmed: true };
      delete b.releasingBase;
      delete b.releasingFeeBase;
      state.putBounty(b);
      state.bumpStat('bountiesReleased');
      state.addStatBase('releasedBase', payout);
      state.addStatBase('feesLifetimeBase', fee);
      state.addSweepable(fee);
      record(state, 'release', b, { party: b.claimer, amountBase: payout.toString(), feeBase: fee.toString(), unconfirmed: true, note: 'recovered on restart' });
      recovered.push(`#${b.id} release ${client.fmt(payout)}`);
    } else if (b.status === STATUS.REFUNDING) {
      const amt = BigInt(b.refundingBase ?? '0');
      b.status = STATUS.REFUNDED;
      b.refundUnconfirmed = true;
      b.resolvedAt = now;
      b.outcome = { kind: 'refunded', recovered: true, unconfirmed: true };
      delete b.refundingBase;
      state.putBounty(b);
      state.bumpStat('bountiesRefunded');
      state.addStatBase('refundedBase', amt);
      record(state, 'refund', b, { party: b.poster, amountBase: amt.toString(), unconfirmed: true, note: 'recovered on restart' });
      recovered.push(`#${b.id} refund ${client.fmt(amt)}`);
    }
  }

  if (recovered.length) {
    state.save();
    const line = '─'.repeat(60);
    log.warn(`\n${line}`);
    log.warn('  RECOVERED INTERRUPTED SENDS (were in flight during shutdown):');
    for (const r of recovered) log.warn(`    • ${r}`);
    log.warn('  These were NOT resent (double-pay guard). Verify each against the wallet.');
    log.warn(`${line}\n`);
    await notifyOwner(client, state, rateLimit, `Recovered ${recovered.length} interrupted send(s) on restart (marked unconfirmed, NOT resent): ${recovered.join('; ')}. Please verify against the wallet.`);
  }
  return recovered;
}

export default {
  createBounty,
  applyIncomingFunds,
  claimBounty,
  submitProof,
  confirmBounty,
  rejectProof,
  cancelBounty,
  addReward,
  ownerResolve,
  sweep,
  reconcileInterrupted,
  summarizeBounty,
  describeBounty,
};
