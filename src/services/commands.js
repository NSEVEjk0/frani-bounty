/**
 * frani-bounty — DM command router
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Every interaction with the board happens over an encrypted DM. This module
 * parses one inbound message and dispatches it. A leading `!` is optional on
 * every command (`!create` == `create`).
 *
 *   Public (anyone):
 *     create <reward> <title>     — post a bounty; fund the reward into escrow
 *     claim <id>                  — take an open bounty
 *     submit <id> <proof>         — submit your work for a claimed bounty
 *     confirm <id>                — (poster) accept proof → release the reward
 *     reject <id> [reason]        — (poster) reject proof → worker may resubmit
 *     cancel <id>                 — (poster) cancel a draft/open bounty → refund
 *     boost <id> <amount>         — add to a live bounty's reward
 *     view <id>                   — full detail of one bounty
 *     list                        — the open bounties right now
 *     mine                        — bounties you posted or are working on
 *     status                      — board-wide figures & rules
 *     history                     — your recent activity
 *     about | help                — what this is / command list
 *
 *   Owner-only (sender pubkey == OWNER_PUBKEY; disabled unless configured):
 *     pause | resume              — freeze / unfreeze ALL outflow instantly
 *     resolve <id> release|refund — settle a dispute either way
 *     withdraw <amount>           — sweep accrued fees/tips to the owner
 *     blacklist <pubkey> [on|off] — block / unblock an account
 *     params                      — dump the active policy knobs
 *     admin                       — owner command list
 */

import config from '../config.js';
import { createLogger } from '../logger.js';
import { normalizeKey, STATUS, TERMINAL_STATUSES } from '../state.js';
import bounty from '../bounty.js';
import { reply, recipientOfDm, sig } from '../reply.js';

const log = createLogger('commands');

const AMOUNT_RE = /^\d+(\.\d+)?$/;
const MAX_SANE_WHOLE = 1_000_000; // reject absurd amounts before base-unit conversion

/** Is this DM from the configured owner identity? */
function isOwner(dm) {
  if (!config.admin.enabled) return false;
  return normalizeKey(dm.senderPubkey) === normalizeKey(config.admin.ownerPubkey);
}

function isAmount(s) {
  return s && AMOUNT_RE.test(s) && Number.parseFloat(s) > 0 && Number.parseFloat(s) <= MAX_SANE_WHOLE;
}

// ── shared status rendering (used by DM `status` and index.js `--status`) ─────
export async function boardStatusLines(client, state, now = Date.now()) {
  const s = state.stats;
  const balanceBase = await client.effectiveSpendableBase();
  const escrowBase = state.escrowedTotalBase();
  const sweepable = state.sweepableBase;
  const open = state.openBounties().length;
  const held = state.bountiesWhere((b) => !TERMINAL_STATUSES.has(b.status)).length;
  const live = config.safety.releaseEnabled && !state.paused;

  return [
    `🎯 frani-bounty — status`,
    `Spendable balance : ${client.fmt(balanceBase)}`,
    `In escrow (held)  : ${client.fmt(escrowBase)} across ${held} active bounty(ies)`,
    `Open to claim     : ${open}`,
    `Withdrawable fees : ${client.fmt(sweepable)}`,
    `Outflow           : ${live ? 'LIVE ✅' : 'PAUSED ⏸️'}`,
    ``,
    `Rules: reward ${config.bounty.minRewardWhole}–${config.bounty.maxRewardWhole} ${client.coin.symbol} · fee ${config.bounty.feeBps / 100}% on release · refunds always full`,
    `Windows: fund ${config.bounty.fundWindowHours}h · claim ${config.bounty.claimWindowHours}h · confirm ${config.bounty.confirmWindowHours}h · open ${config.bounty.openExpiryDays}d`,
    ``,
    `Lifetime: ${s.bountiesCreated} created · ${s.bountiesFunded} funded · ${s.bountiesReleased} released · ${s.bountiesRefunded} refunded (${s.bountiesExpired} expired, ${s.bountiesCancelled} cancelled)`,
    `Paid to workers ${client.fmt(BigInt(s.releasedBase))} · fees earned ${client.fmt(BigInt(s.feesLifetimeBase))} · tips ${client.fmt(BigInt(s.tipsLifetimeBase))}`,
  ];
}

// ── public command handlers ───────────────────────────────────────────────────
async function cmdCreate(client, state, rateLimit, dm, parts) {
  const recipient = recipientOfDm(dm);
  const amountStr = parts[1];
  const title = parts.slice(2).join(' ');
  if (!isAmount(amountStr) || !title) {
    await reply(client, recipient, rateLimit, [
      `❓ Usage: \`create <reward> <what needs doing>\``,
      `e.g. \`create 5 Write a haiku about Unicity\``,
      `Reward must be ${config.bounty.minRewardWhole}–${config.bounty.maxRewardWhole} ${client.coin.symbol}; you fund it into escrow and the worker receives it minus a ${config.bounty.feeBps / 100}% fee on release.`,
      sig(),
    ].join('\n'), { priority: true });
    return;
  }
  await bounty.createBounty(client, state, rateLimit, { dm, rewardWhole: amountStr, title });
}

async function cmdClaim(client, state, rateLimit, dm, parts) {
  const id = parts[1];
  if (!id) {
    await reply(client, recipientOfDm(dm), rateLimit, `Usage: \`claim <id>\` — see open bounties with \`list\`. ${sig()}`, { priority: true });
    return;
  }
  await bounty.claimBounty(client, state, rateLimit, { dm, bountyId: id });
}

async function cmdSubmit(client, state, rateLimit, dm, parts) {
  const id = parts[1];
  const proof = parts.slice(2).join(' ');
  if (!id || !proof) {
    await reply(client, recipientOfDm(dm), rateLimit, `Usage: \`submit <id> <link or description of your work>\`. ${sig()}`, { priority: true });
    return;
  }
  await bounty.submitProof(client, state, rateLimit, { dm, bountyId: id, proof });
}

async function cmdConfirm(client, state, rateLimit, dm, parts) {
  const id = parts[1];
  if (!id) {
    await reply(client, recipientOfDm(dm), rateLimit, `Usage: \`confirm <id>\` — accept the proof and release the reward. ${sig()}`, { priority: true });
    return;
  }
  await bounty.confirmBounty(client, state, rateLimit, { dm, bountyId: id, byOwner: isOwner(dm) });
}

async function cmdReject(client, state, rateLimit, dm, parts) {
  const id = parts[1];
  const reason = parts.slice(2).join(' ');
  if (!id) {
    await reply(client, recipientOfDm(dm), rateLimit, `Usage: \`reject <id> [reason]\`. ${sig()}`, { priority: true });
    return;
  }
  await bounty.rejectProof(client, state, rateLimit, { dm, bountyId: id, reason, byOwner: isOwner(dm) });
}

async function cmdCancel(client, state, rateLimit, dm, parts) {
  const id = parts[1];
  if (!id) {
    await reply(client, recipientOfDm(dm), rateLimit, `Usage: \`cancel <id>\` — cancels a draft/open bounty and refunds you. ${sig()}`, { priority: true });
    return;
  }
  await bounty.cancelBounty(client, state, rateLimit, { dm, bountyId: id, byOwner: isOwner(dm) });
}

async function cmdBoost(client, state, rateLimit, dm, parts) {
  const id = parts[1];
  const amountStr = parts[2];
  if (!id || !isAmount(amountStr)) {
    await reply(client, recipientOfDm(dm), rateLimit, `Usage: \`boost <id> <amount>\` — add to a live bounty's reward. ${sig()}`, { priority: true });
    return;
  }
  await bounty.addReward(client, state, rateLimit, { dm, bountyId: id, amountWhole: amountStr });
}

async function cmdView(client, state, rateLimit, dm, parts) {
  const id = parts[1];
  const b = id ? state.getBounty(id) : null;
  if (!b) {
    await reply(client, recipientOfDm(dm), rateLimit, `No bounty #${id ?? '?'}. Try \`list\`. ${sig()}`, { priority: true });
    return;
  }
  await reply(client, recipientOfDm(dm), rateLimit, `${bounty.describeBounty(client, b)}\n${sig()}`, { priority: true });
}

async function cmdList(client, state, rateLimit, dm) {
  const open = state.openBounties().sort((a, b) => a.createdAt - b.createdAt).slice(0, 15);
  const lines = [`🎯 Open bounties (${open.length}):`];
  if (!open.length) lines.push(`   (none right now — post one with \`create <reward> <title>\`)`);
  else for (const b of open) lines.push(`   ${bounty.summarizeBounty(client, b)}`);
  lines.push(``, `\`view <id>\` for detail · \`claim <id>\` to take one.`, sig());
  await reply(client, recipientOfDm(dm), rateLimit, lines.join('\n'), { priority: true });
}

async function cmdMine(client, state, rateLimit, dm) {
  const key = normalizeKey(dm.senderPubkey);
  const posted = state.bountiesByPoster(key).filter((b) => !TERMINAL_STATUSES.has(b.status));
  const working = state.bountiesByClaimer(key).filter((b) => !TERMINAL_STATUSES.has(b.status));
  const lines = [`📂 Your bounties:`];
  lines.push(`  Posted (${posted.length}):`);
  if (!posted.length) lines.push(`    (none active)`);
  else for (const b of posted) lines.push(`    ${bounty.summarizeBounty(client, b)}`);
  lines.push(`  Working on (${working.length}):`);
  if (!working.length) lines.push(`    (none active)`);
  else for (const b of working) lines.push(`    ${bounty.summarizeBounty(client, b)}`);
  lines.push(sig());
  await reply(client, recipientOfDm(dm), rateLimit, lines.join('\n'), { priority: true });
}

async function cmdHistory(client, state, rateLimit, dm) {
  const entries = state.recentLedgerFor(dm.senderPubkey, 10);
  const lines = [`📜 Your recent activity:`];
  if (!entries.length) lines.push(`   (nothing yet — post with \`create\` or take one with \`claim\`)`);
  else for (const e of entries) {
    const when = new Date(e.at).toISOString().slice(0, 16).replace('T', ' ');
    const amt = e.amountBase ? ` ${client.fmt(BigInt(e.amountBase))}` : '';
    const note = e.unconfirmed ? ' — unconfirmed, check your wallet' : e.note ? ` (${e.note})` : '';
    lines.push(`   ${when}  ${e.kind} ${e.bountyId ? `#${e.bountyId}` : ''}${amt}${note}`);
  }
  lines.push(sig());
  await reply(client, recipientOfDm(dm), rateLimit, lines.join('\n'), { priority: true });
}

async function cmdStatus(client, state, rateLimit, dm) {
  const lines = await boardStatusLines(client, state);
  lines.push(``, sig());
  await reply(client, recipientOfDm(dm), rateLimit, lines.join('\n'), { priority: true });
}

async function cmdAbout(client, state, rateLimit, dm) {
  const body = [
    `🎯 frani-bounty — an autonomous bounty board & custodial escrow on Unicity testnet2.`,
    ``,
    config.publish.serviceDescription,
    ``,
    `Owner / Creator: ${config.owner}. Made by ${config.brand}.`,
    `Send \`help\` for commands, \`status\` for live figures, \`list\` for open bounties.`,
    sig(),
  ].join('\n');
  await reply(client, recipientOfDm(dm), rateLimit, body, { priority: true });
}

async function cmdHelp(client, state, rateLimit, dm) {
  const lines = [
    `🤖 frani-bounty commands (the \`!\` prefix is optional):`,
    `  create <reward> <title>  — post a bounty & fund the reward into escrow`,
    `  list                     — open bounties right now`,
    `  view <id>                — full detail of one bounty`,
    `  claim <id>               — take an open bounty`,
    `  submit <id> <proof>      — submit your work`,
    `  confirm <id>             — (poster) accept proof → release reward`,
    `  reject <id> [reason]     — (poster) reject proof → resubmit allowed`,
    `  cancel <id>              — (poster) cancel a draft/open bounty → refund`,
    `  boost <id> <amount>      — add to a live bounty's reward`,
    `  mine                     — bounties you posted or are working on`,
    `  status                   — board figures & rules`,
    `  history                  — your recent activity`,
    `  about                    — what this service is`,
  ];
  if (isOwner(dm)) lines.push(`  admin                    — owner commands`);
  lines.push(``, `New here? \`create 2 <task>\` posts your first bounty. Refunds on cancel/expiry are always full.`, sig());
  await reply(client, recipientOfDm(dm), rateLimit, lines.join('\n'), { priority: true });
}

// ── owner-only command handlers ───────────────────────────────────────────────
async function cmdAdminHelp(client, state, rateLimit, dm) {
  const body = [
    `🔐 Owner commands:`,
    `  pause | resume              — freeze / unfreeze ALL outflow instantly`,
    `  resolve <id> release|refund — settle a dispute either way`,
    `  withdraw <amount>           — sweep accrued fees/tips to you`,
    `  blacklist <pubkey> [on|off] — block / unblock an account`,
    `  params                      — active policy knobs`,
    sig(),
  ].join('\n');
  await reply(client, recipientOfDm(dm), rateLimit, body, { priority: true });
}

async function cmdParams(client, state, rateLimit, dm) {
  const t = config.bounty;
  const sf = config.safety;
  const body = [
    `⚙️ Active policy:`,
    `  reward=${t.minRewardWhole}–${t.maxRewardWhole} · maxTotalEscrow=${t.maxTotalEscrowWhole} · fee=${t.feeBps}bps (UCT)`,
    `  perPoster=${t.maxOpenBountiesPerPoster} · perClaimer=${t.maxActiveClaimsPerClaimer} · proofAttempts=${t.maxProofAttempts}`,
    `  windows fund=${t.fundWindowHours}h claim=${t.claimWindowHours}h confirm=${t.confirmWindowHours}h open=${t.openExpiryDays}d`,
    `  releaseEnabled=${sf.releaseEnabled} · paused=${state.paused} · dryRun=${sf.dryRun} · autoRelease=${sf.autoReleaseOnConfirmTimeout}`,
    `  maxReleases/h=${sf.maxReleasesPerHour} · floor=${sf.minBalanceFloorWhole} · sweepable=${client.fmt(state.sweepableBase)}`,
    sig(),
  ].join('\n');
  await reply(client, recipientOfDm(dm), rateLimit, body, { priority: true });
}

async function cmdPause(client, state, rateLimit, dm, on) {
  state.setPaused(on);
  state.save();
  log.warn(`Owner ${on ? 'PAUSED' : 'RESUMED'} all outflow.`);
  await reply(client, recipientOfDm(dm), rateLimit, `${on ? '⏸️ Outflow paused — escrow safe, nothing pays out.' : '▶️ Outflow resumed.'} ${sig()}`, { priority: true });
}

async function cmdResolve(client, state, rateLimit, dm, parts) {
  const id = parts[1];
  const action = (parts[2] ?? '').toLowerCase();
  if (!id || (action !== 'release' && action !== 'refund')) {
    await reply(client, recipientOfDm(dm), rateLimit, `Usage: \`resolve <id> release|refund\`. ${sig()}`, { priority: true });
    return;
  }
  await bounty.ownerResolve(client, state, rateLimit, { dm, bountyId: id, action });
}

async function cmdWithdraw(client, state, rateLimit, dm, parts) {
  const recipient = recipientOfDm(dm);
  const amountStr = parts[1];
  if (!isAmount(amountStr)) {
    await reply(client, recipient, rateLimit, `Usage: \`withdraw <amount>\` — sweeps accrued fees/tips (available: ${client.fmt(state.sweepableBase)}). ${sig()}`, { priority: true });
    return;
  }
  const amountBase = client.toBase(amountStr);
  if (amountBase > state.sweepableBase) {
    await reply(client, recipient, rateLimit, `Only ${client.fmt(state.sweepableBase)} is withdrawable (fees + tips). ${sig()}`, { priority: true });
    return;
  }
  // Protect ALL live escrow — never sweep earnings out of custody.
  const keepFloorBase = state.escrowedTotalBase();
  const res = await client.sweepFees(recipient, amountBase, `frani-bounty fee sweep`, keepFloorBase);
  if (res?.skipped) {
    await reply(client, recipient, rateLimit, `Withdraw held (${res.skipped}) — escrow is protected. ${sig()}`, { priority: true });
    return;
  }
  const unconfirmed = res?.ambiguous === true;
  state.addSweepable(-amountBase);
  state.addStatBase('feesSweptBase', amountBase);
  state.appendLedger({ kind: 'withdraw', party: normalizeKey(dm.senderPubkey), amountBase: amountBase.toString(), unconfirmed, at: Date.now() });
  state.save();
  await reply(client, recipient, rateLimit, unconfirmed
    ? `Withdrew ${client.fmt(amountBase)} (network confirmation pending — verify against the wallet). ${sig()}`
    : `✅ Withdrew ${client.fmt(amountBase)} of fees/tips to you. Remaining: ${client.fmt(state.sweepableBase)}. ${sig()}`, { priority: true });
}

async function cmdBlacklist(client, state, rateLimit, dm, parts) {
  const target = parts[1];
  const on = !/^(off|false|0|no)$/i.test(parts[2] ?? 'on');
  if (!target) {
    await reply(client, recipientOfDm(dm), rateLimit, `Usage: \`blacklist <pubkey> [on|off]\`. ${sig()}`, { priority: true });
    return;
  }
  state.setBlacklist(target, on);
  state.save();
  log.warn(`Owner ${on ? 'blacklisted' : 'un-blacklisted'} ${String(target).slice(0, 16)}.`);
  await reply(client, recipientOfDm(dm), rateLimit, `✅ ${String(target).slice(0, 12)}… ${on ? 'blacklisted' : 'un-blacklisted'}. ${sig()}`, { priority: true });
}

// ── dispatch ────────────────────────────────────────────────────────────────
const OWNER_COMMANDS = new Set(['admin', 'params', 'pause', 'resume', 'resolve', 'withdraw', 'blacklist']);

/**
 * Parse and handle one inbound DM. Callers (agent.js) must have already
 * de-duplicated the message id, so this runs at most once per message.
 */
export async function handleDm(client, state, rateLimit, dm) {
  const raw = String(dm.content ?? '').trim();
  if (!raw) return;

  const parts = raw.replace(/^!/, '').trim().split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase();
  const recipient = recipientOfDm(dm);
  log.info(`DM from ${recipient}: ${cmd || '(empty)'}${parts.length > 1 ? ' …' : ''}`);

  // Owner-only surface.
  if (OWNER_COMMANDS.has(cmd)) {
    if (!isOwner(dm)) {
      await reply(client, recipient, rateLimit, `❓ Unknown command. Send \`help\` for what I can do. ${sig()}`);
      return;
    }
    switch (cmd) {
      case 'admin': return cmdAdminHelp(client, state, rateLimit, dm);
      case 'params': return cmdParams(client, state, rateLimit, dm);
      case 'pause': return cmdPause(client, state, rateLimit, dm, true);
      case 'resume': return cmdPause(client, state, rateLimit, dm, false);
      case 'resolve': return cmdResolve(client, state, rateLimit, dm, parts);
      case 'withdraw': return cmdWithdraw(client, state, rateLimit, dm, parts);
      case 'blacklist': return cmdBlacklist(client, state, rateLimit, dm, parts);
    }
  }

  // Public surface.
  switch (cmd) {
    case 'create':
    case 'post':
    case 'new':
      return cmdCreate(client, state, rateLimit, dm, parts);
    case 'claim':
    case 'take':
      return cmdClaim(client, state, rateLimit, dm, parts);
    case 'submit':
    case 'proof':
      return cmdSubmit(client, state, rateLimit, dm, parts);
    case 'confirm':
    case 'accept':
    case 'approve':
      return cmdConfirm(client, state, rateLimit, dm, parts);
    case 'reject':
    case 'deny':
      return cmdReject(client, state, rateLimit, dm, parts);
    case 'cancel':
    case 'withdraw-bounty':
      return cmdCancel(client, state, rateLimit, dm, parts);
    case 'boost':
    case 'add-reward':
    case 'addreward':
    case 'tip':
      return cmdBoost(client, state, rateLimit, dm, parts);
    case 'view':
    case 'show':
    case 'bounty':
      return cmdView(client, state, rateLimit, dm, parts);
    case 'list':
    case 'open':
    case 'bounties':
      return cmdList(client, state, rateLimit, dm);
    case 'mine':
    case 'my':
      return cmdMine(client, state, rateLimit, dm);
    case 'status':
    case 'board':
      return cmdStatus(client, state, rateLimit, dm);
    case 'history':
    case 'log':
      return cmdHistory(client, state, rateLimit, dm);
    case 'about':
    case 'intent':
      return cmdAbout(client, state, rateLimit, dm);
    case 'help':
    case 'commands':
    case 'start':
    case 'hi':
    case 'hello':
    case '?':
      return cmdHelp(client, state, rateLimit, dm);
    default:
      await reply(client, recipient, rateLimit, `👋 I'm frani-bounty. Send \`help\` for commands, \`list\` to see open bounties, or \`create <reward> <title>\` to post one. ${sig()}`);
      return;
  }
}

export default { handleDm, boardStatusLines };
