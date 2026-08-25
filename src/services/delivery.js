/**
 * frani-bounty — public advertising
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * How the board announces itself to the network:
 *   • ensureServiceIntent — keep a standing `service` intent on the market board
 *     so other agents can discover the bounty board. Reconciled against the
 *     server: re-posted only if the previously stored one is gone.
 *   • broadcastHeartbeat  — optional public status line (off by default): how many
 *     bounties are open and how much reward is up for grabs right now.
 */

import config from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('delivery');

/**
 * Publish (or re-publish) the standing `service` intent advertising the board.
 * Idempotent: if the stored intent is still active on the server we leave it be.
 */
export async function ensureServiceIntent(client, state) {
  if (!config.publish.serviceIntentEnabled) return;
  if (config.safety.dryRun) {
    log.warn(`[DRY_RUN] Would publish the @${config.nametag} service intent.`);
    return;
  }
  try {
    if (state.serviceIntentId) {
      const mine = await client.sphere.market.getMyIntents();
      const alive = mine.some((m) => m.id === state.serviceIntentId && m.status === 'active');
      if (alive) {
        log.info(`Service intent already live (${String(state.serviceIntentId).slice(0, 10)}…).`);
        return;
      }
    }
    const result = await client.sphere.market.postIntent({
      description: config.publish.serviceDescription,
      intentType: 'service',
      category: 'data',
      currency: config.coinSymbol,
      contactHandle: client.nametag ? `@${client.nametag}` : undefined,
      expiresInDays: config.publish.intentExpiresInDays,
    });
    state.setServiceIntentId(result.intentId);
    state.save();
    log.info(`Published service intent ${String(result.intentId).slice(0, 10)}… (expires ${result.expiresAt}).`);
  } catch (err) {
    log.warn(`Could not publish service intent (non-fatal): ${err?.message ?? err}`);
  }
}

/**
 * Optional public transparency heartbeat: a short line summarising how many
 * bounties are open and the total reward on offer. Off unless BROADCAST_ENABLED.
 */
export async function broadcastHeartbeat(client, state, rateLimit) {
  if (!config.publish.broadcastEnabled) return;
  if (!rateLimit.allow('action', config.safety.maxActionsPerHour)) return;
  const open = state.openBounties();
  const upForGrabs = open.reduce((a, b) => a + BigInt(b.rewardBase), 0n);
  const live = config.safety.releaseEnabled && !state.paused;
  const line =
    `🎯 frani-bounty ${live ? 'LIVE' : 'PAUSED'} · ${open.length} open bounty(ies) · ` +
    `${client.fmt(upForGrabs)} in rewards up for grabs · DM \`list\` to browse, ` +
    `\`create <reward> <title>\` to post. Custodial escrow, ${config.bounty.feeBps / 100}% fee, full refunds. Made by ${config.brand}.`;
  await client.broadcast(line);
}

export default { ensureServiceIntent, broadcastHeartbeat };
