/**
 * frani-bounty — outbound DM helper
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * One place for "reply to a party over DM", shared by the command router and
 * the bounty lifecycle. Honours the politeness rate caps, except for `priority`
 * messages (escrow receipts, release/refund notices, funding outcomes) which a
 * party is owed a response to and which therefore bypass the anti-spam ceiling.
 */

import config from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('reply');

/** Prefer a nametag handle, fall back to the raw pubkey. */
export function recipientFromSender(pubkey, nametag) {
  return nametag ? `@${nametag}` : pubkey;
}
export function recipientOfDm(dm) {
  return recipientFromSender(dm.senderPubkey, dm.senderNametag);
}

export function underCaps(rateLimit) {
  return (
    rateLimit.peek('dm', config.safety.maxDmsPerHour) &&
    rateLimit.peek('action', config.safety.maxActionsPerHour)
  );
}
export function noteSend(rateLimit) {
  rateLimit.record('dm');
  rateLimit.record('action');
}

/**
 * Send a DM, respecting the hourly caps. `priority` messages (an escrow receipt,
 * a release/refund notice) are always sent — the party acted and is owed the
 * reply — but still recorded so the counters stay honest.
 * @returns {Promise<boolean>} whether the message was sent
 */
export async function reply(client, recipient, rateLimit, body, { priority = false } = {}) {
  if (!priority && !underCaps(rateLimit)) {
    log.warn(`Rate cap reached — dropping reply to ${recipient}.`);
    return false;
  }
  noteSend(rateLimit);
  await client.sendDM(recipient, body);
  return true;
}

/** Standard signature line appended to public-facing messages. */
export function sig() {
  return `— ${config.brand}`;
}

export default { reply, recipientOfDm, recipientFromSender, underCaps, noteSend, sig };
