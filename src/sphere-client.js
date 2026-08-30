/**
 * frani-bounty — Sphere client: identity, wallet, and money primitives
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Wraps @unicitylabs/sphere-sdk for a headless Node.js escrow agent on testnet2:
 *   • builds Node providers (storage + Nostr transport + aggregator oracle)
 *     and the required wallet-api transport layer
 *   • load-or-create identity from a locally-persisted BIP39 mnemonic
 *   • registers the @nametag, resolves the UCT coin, checks balance
 *   • exposes the guarded outbound primitives — `release`, `refund`, `sweepFees`
 *     — plus `requestPayment` (the escrow-funding invoice) and `declineInbound`.
 *
 * Money policy = CUSTODIAL ESCROW + STRICT OUTFLOW. Outbound UCT leaves ONLY to
 * (a) release a reward (minus fee) to a confirmed claimer, (b) refund a poster in
 * full, or (c) sweep accrued fees/tips to the owner. Every path honours DRY_RUN,
 * the RELEASE_ENABLED kill-switch, and an independent co-mingling guard: the send
 * is refused if it would drop the spendable balance below the escrow still owed
 * to OTHER bounties — so even a bug in the state machine cannot pay one bounty's
 * reward out of another's escrow. Non-clean sends are reported as `ambiguous` and
 * never retried (double-pay guard).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  Sphere,
  NETWORKS,
  isSphereError,
  isValidNametag,
  getCoinIdBySymbol,
  getTokenDecimals,
} from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

import config from './config.js';
import { createLogger } from './logger.js';
import { toBaseUnits, toWholeString } from './money.js';

const log = createLogger('sphere');

// After an outbound send, the consumed tokens sit in `transferringAmount` and the
// live confirmed balance reads ~0 until the change settles (seconds to ~90s under
// load). For this window we trust the local book balance over the chain read and
// refuse to reconcile — long enough to cover a slow settle plus wallet-api lag.
const SEND_GUARD_MS = 180_000;

// Re-export the money helpers so callers can import them from the client too.
export { toBaseUnits, toWholeString };

// ── small utilities ─────────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function fmtErr(err) {
  if (isSphereError(err)) return `${err.code}: ${err.message}`;
  return err?.message ?? String(err);
}

// ── file-backed identity bits ───────────────────────────────────────────────
function walletPaths() {
  const dir = resolve(config.walletDir);
  return {
    dir,
    mnemonic: join(dir, 'mnemonic.txt'),
    deviceId: join(dir, 'device-id.txt'),
  };
}

function ensureWalletDir() {
  const { dir } = walletPaths();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function loadOrCreateDeviceId() {
  const { deviceId } = walletPaths();
  if (existsSync(deviceId)) return readFileSync(deviceId, 'utf8').trim();
  const id = `${config.nametag}-${randomUUID()}`;
  writeFileSync(deviceId, `${id}\n`, { mode: 0o600 });
  return id;
}

function readMnemonicFile() {
  const { mnemonic } = walletPaths();
  return existsSync(mnemonic) ? readFileSync(mnemonic, 'utf8').trim() : undefined;
}

function saveMnemonicFile(phrase) {
  const { mnemonic } = walletPaths();
  writeFileSync(mnemonic, `${phrase}\n`, { mode: 0o600 });
}

function printMnemonicBanner(phrase, saved) {
  const line = '═'.repeat(72);
  log.warn(`\n${line}`);
  log.warn(`  🔑  NEW IDENTITY CREATED FOR @${config.nametag}`);
  log.warn('  This BIP39 recovery phrase controls the escrow wallet AND all funds held in it.');
  log.warn('  BACK IT UP OFFLINE. It is shown ONCE and never printed again.');
  log.warn(line);
  log.warn(`  ${phrase}`);
  log.warn(line);
  log.warn(
    saved
      ? `  Also saved (mode 0600) to ${walletPaths().mnemonic}`
      : '  Not written to disk (WALLET_PASSWORD set).',
  );
  log.warn(`${line}\n`);
}

// ── token registry fallback (used when the SDK cache is not yet populated) ──
async function fetchRegistrySymbol(symbol) {
  const net = NETWORKS[config.network] ?? NETWORKS.testnet2 ?? NETWORKS.testnet;
  const url = net?.tokenRegistryUrl;
  if (!url) return undefined;
  const res = await withTimeout(fetch(url), 15_000, 'token-registry fetch');
  if (!res.ok) throw new Error(`token registry HTTP ${res.status}`);
  const listJson = await res.json();
  const arr = Array.isArray(listJson) ? listJson : [];
  return arr.find(
    (e) => e?.assetKind === 'fungible' && String(e?.symbol).toUpperCase() === symbol.toUpperCase(),
  );
}

async function resolveCoin(symbol) {
  let coinId;
  try {
    coinId = getCoinIdBySymbol(symbol) || undefined;
  } catch {
    /* registry not loaded yet */
  }
  let decimals;
  if (coinId) {
    try {
      const d = getTokenDecimals(coinId);
      if (Number.isFinite(d)) decimals = d;
    } catch {
      /* fall through to registry */
    }
  }
  if (!coinId || decimals == null) {
    const entry = await fetchRegistrySymbol(symbol);
    if (!entry) throw new Error(`Coin symbol "${symbol}" not found in the testnet2 registry`);
    coinId = coinId ?? entry.id;
    decimals = decimals ?? entry.decimals;
  }
  log.info(`Resolved ${symbol}: coinId=${coinId.slice(0, 12)}… decimals=${decimals}`);
  return { symbol, coinId, decimals };
}

/**
 * SphereClient — the board's handle on the network. Bundles the initialized
 * Sphere instance, the resolved coin, and guarded high-level actions.
 */
export class SphereClient {
  constructor(sphere, coin, deviceId, created) {
    this.sphere = sphere;
    this.coin = coin;
    this.deviceId = deviceId;
    this.created = created;
  }

  /** Boot providers + identity. Load-or-create from the local mnemonic file. */
  static async boot() {
    ensureWalletDir();
    const deviceId = loadOrCreateDeviceId();

    const base = createNodeProviders({
      network: config.network,
      dataDir: resolve(config.walletDir),
      walletFileName: config.walletFileName,
      oracle: { apiKey: config.oracleApiKey },
      market: true,
    });

    const providers = createWalletApiProviders(base, {
      baseUrl: config.walletApiUrl,
      network: config.network,
      deviceId,
    });

    const fileMnemonic = config.password ? undefined : readMnemonicFile();
    const initOpts = {
      ...providers,
      network: config.network, // engine/registry network — must match walletApi.network
      market: true,
      communications: {},
      dmSince: Math.floor(Date.now() / 1000) - 86_400, // catch DMs from the last 24h on connect
      ...(config.password ? { password: config.password } : {}),
      ...(fileMnemonic ? { mnemonic: fileMnemonic } : { autoGenerate: true }),
    };

    log.info(`Connecting to ${config.network} as @${config.nametag} (device ${deviceId})…`);
    const { sphere, created, generatedMnemonic } = await withTimeout(
      Sphere.init(initOpts),
      60_000,
      'Sphere.init',
    );

    if (created && generatedMnemonic) {
      const shouldSave = !config.password; // don't scatter a plaintext phrase when encrypting the store
      if (shouldSave) saveMnemonicFile(generatedMnemonic);
      printMnemonicBanner(generatedMnemonic, shouldSave);
    } else {
      log.info(created ? 'New wallet created.' : 'Existing wallet loaded.');
    }

    const coin = await resolveCoin(config.coinSymbol);
    const client = new SphereClient(sphere, coin, deviceId, created);
    log.info(`Identity ready: ${client.describe()}`);
    return client;
  }

  // ── identity accessors ────────────────────────────────────────────────────
  get identity() {
    return this.sphere.identity ?? {};
  }

  get nametag() {
    return this.identity.nametag?.replace(/^@/, '') || null;
  }

  get address() {
    return this.identity.directAddress || this.identity.chainPubkey || null;
  }

  /** Both key encodings that may echo back as "self" on the relay. */
  selfPubkeys() {
    const set = new Set();
    const cp = this.identity.chainPubkey;
    if (cp) {
      set.add(cp);
      if (cp.length === 66) set.add(cp.slice(2)); // 32-byte x-only form
    }
    return set;
  }

  describe() {
    return `@${this.nametag ?? '(unregistered)'} · ${this.address ?? '?'}`;
  }

  // ── balance ───────────────────────────────────────────────────────────────
  /**
   * Read our coin's asset row, and say whether we actually got one.
   *
   * `payments.assets()` resolves with an EMPTY ARRAY when the wallet-api cannot
   * be reached — it does not throw. So "no row for our coin" is two different
   * facts wearing the same clothes: a wallet that genuinely holds nothing, and a
   * backend that never answered. That matters most in the reconcile below: an
   * empty read makes `transferringAmount` and `unconfirmedAmount` both parse as
   * 0, so the wallet looks *quiescent* and the book would be overwritten with a
   * zero we do not actually have — and persisted to disk.
   */
  async _coinRow() {
    const assets = await this.sphere.payments.assets(this.coin.coinId);
    const row = Array.isArray(assets)
      ? assets.find((x) => x.coinId === this.coin.coinId)
      : undefined;
    return { present: !!row, row: row ?? {} };
  }

  async spendableBase() {
    const { row } = await this._coinRow();
    return BigInt(row.confirmedAmount ?? row.totalAmount ?? '0');
  }

  async spendableWhole() {
    return toWholeString(await this.spendableBase(), this.coin.decimals);
  }

  /** Attach the persisted state so the client can keep the book balance. */
  attachState(state) {
    this._state = state;
    return this;
  }

  /**
   * The spendable corpus the board should act on — lag-free and safe.
   *
   * The chain read alone is unusable for gating outflow: during a token's
   * in-flight settle window ALL involved funds (the amount leaving AND the change
   * returning) sit in `transferringAmount`, while `confirmedAmount` reads ~0. So
   * we keep a local book: debit it the instant we attempt a send (in `_send`),
   * and reconcile it back to the on-chain `confirmedAmount` whenever the wallet is
   * quiescent (nothing transferring or unconfirmed) AND no send is within its
   * settle guard. That reconcile is the anchor that heals any drift — including an
   * ambiguous send that never actually left, and incoming escrow that has since
   * confirmed — so the book self-corrects to truth every time the wallet goes
   * quiet, but never mid-settle. Because incoming escrow is only reflected on the
   * (upward) reconcile, the book is conservative between funding and quiescence —
   * which only ever makes the outflow guard stricter, never looser.
   */
  async effectiveSpendableBase() {
    const { present, row: a } = await this._coinRow();
    const confirmed = BigInt(a.confirmedAmount ?? '0');
    const st = this._state;
    if (!st) return confirmed; // no attached ledger (one-shot CLI) → best-effort chain read

    if (!present) {
      // The wallet-api gave us nothing. Keep the last known book untouched and
      // let the next real read heal it; never write a zero we cannot vouch for.
      const known = st.getBookBase();
      if (known != null) return known;
      return confirmed; // no anchor yet either — report 0 but do NOT persist it
    }

    const transferring = BigInt(a.transferringAmount ?? '0');
    const unconfirmed = BigInt(a.unconfirmedAmount ?? '0');
    const quiescent = transferring === 0n && unconfirmed === 0n;
    const guardActive = this._sendGuardUntil != null && Date.now() < this._sendGuardUntil;

    let book = st.getBookBase();
    if (book == null) {
      book = confirmed; // first-ever anchor to the chain
      st.setBookBase(book);
      st.save();
    } else if (quiescent && !guardActive && book !== confirmed) {
      book = confirmed; // settled and no send in flight → the chain is the truth
      st.setBookBase(book);
      st.save();
    }
    return book;
  }

  async effectiveSpendableWhole() {
    return toWholeString(await this.effectiveSpendableBase(), this.coin.decimals);
  }

  toBase(whole) {
    return toBaseUnits(whole, this.coin.decimals);
  }

  toWhole(base) {
    return toWholeString(base, this.coin.decimals);
  }

  fmt(base) {
    return `${this.toWhole(base)} ${this.coin.symbol}`;
  }

  // ── nametag ────────────────────────────────────────────────────────────────
  async ensureNametag() {
    if (this.nametag) {
      log.info(`Nametag already held: @${this.nametag}`);
      return this.nametag;
    }
    if (!isValidNametag(config.nametag)) {
      log.warn(`Configured nametag "${config.nametag}" is invalid; running keys-only.`);
      return null;
    }
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would register nametag @${config.nametag}.`);
      return null;
    }
    try {
      const available = await this.sphere.isNametagAvailable(config.nametag);
      if (!available) {
        log.warn(`Nametag @${config.nametag} is taken by another identity; running keys-only.`);
        return null;
      }
      await this.sphere.registerNametag(config.nametag);
      log.info(`Registered nametag @${config.nametag}.`);
      return config.nametag;
    } catch (err) {
      log.warn(`Nametag registration failed (non-fatal): ${fmtErr(err)}`);
      return null;
    }
  }

  // ── minting (optional local demo seeding; OFF by default) ────────────────────
  async mint(whole) {
    const base = this.toBase(whole);
    if (base <= 0n) return { success: false, error: 'non-positive amount' };
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would self-mint ${whole} ${this.coin.symbol}.`);
      return { success: false, dryRun: true };
    }
    log.info(`Self-minting ${whole} ${this.coin.symbol}…`);
    const result = await this.sphere.payments.mint(this.coin.coinId, base);
    if (result?.success) {
      log.info(`Minted ${whole} ${this.coin.symbol} (token ${String(result.tokenId).slice(0, 12)}…).`);
      if (this._state) {
        this._state.adjustBook(base); // credit the book immediately
        this._state.save();
      }
    } else {
      log.error(`Mint failed: ${result?.error ?? 'unknown error'}`);
    }
    return result;
  }

  /** Optional one-time seed mint (only if SELF_MINT_ENABLED). Escrow needs none. */
  async bootstrapMintIfNeeded() {
    if (!config.safety.selfMintEnabled) return;
    const amt = config.safety.selfMintAmountWhole;
    if (!amt || amt <= 0) return;
    const { present, row } = await this._coinRow();
    if (!present && !this.created) {
      // An absent row is genuinely ambiguous: it is what an unreachable wallet-api
      // looks like, AND what a wallet holding nothing at all looks like. assets()
      // cannot tell them apart. But a wallet GENERATED THIS BOOT cannot hold
      // funds, so there the absence is definitively a zero and the documented
      // testnet2 self-mint bootstrap is safe. On a pre-existing wallet we refuse:
      // re-minting onto funds we simply failed to read is the worse error.
      log.warn(
        'Balance unavailable (wallet-api gave no asset row) on an existing wallet — ' +
          'skipping seed mint. If this wallet is genuinely empty, top it up ' +
          'deliberately with the daemon stopped rather than guessing here.',
      );
      return;
    }
    if (!present) {
      log.info('Brand-new wallet with no asset row yet — treating as a genuine 0 balance.');
    }
    const balance = BigInt(row.confirmedAmount ?? row.totalAmount ?? '0');
    if (balance > 0n) {
      log.info(`Balance ${this.toWhole(balance)} ${this.coin.symbol} present; skipping seed mint.`);
      return;
    }
    log.info(`Seeding a demo balance with a capped self-mint (SELF_MINT_ENABLED).`);
    await this.mint(amt);
  }

  // ── outbound payment (strict outflow: release / refund / sweepFees only) ─────
  /**
   * Low-level guarded send. Independent of the bounty state machine, this ALWAYS:
   *   • refuses non-positive amounts
   *   • honours DRY_RUN
   *   • re-checks the co-mingling guard against the lag-free book balance: it will
   *     not let spendable fall below `keepFloorBase` (the escrow owed to OTHER
   *     bounties) plus the optional operational floor
   *   • debits the book the instant it commits to an attempt (so a second payout
   *     during the settle window sees the true remaining corpus, not a stale ~0)
   *   • never blindly retries an unconfirmed/uncertified send (double-pay guard):
   *     any non-clean outcome is reported as `ambiguous` — the burn may already be
   *     certified (funds gone) or may have failed, and we must not resend either way.
   */
  async _send(recipient, base, memo, { keepFloorBase = 0n } = {}) {
    base = BigInt(base);
    if (base <= 0n) return { skipped: 'non-positive amount' };
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would send ${this.toWhole(base)} ${this.coin.symbol} to ${recipient}.`);
      return { dryRun: true };
    }
    const balance = await this.effectiveSpendableBase();
    const floor = BigInt(keepFloorBase) + this.toBase(config.safety.minBalanceFloorWhole);
    if (balance - base < floor) {
      log.warn(
        `Refusing send of ${this.toWhole(base)} — would breach the escrow-protection floor ` +
          `(spendable ${this.toWhole(balance)}, must retain ${this.toWhole(floor)} for other escrow).`,
      );
      return { skipped: 'escrow-protect' };
    }
    // Committed to attempt: debit the book NOW and open the settle guard, so any
    // near-simultaneous payout sees the reduced corpus. If the send turns out to
    // have failed, the next quiescent reconcile heals the book back up.
    this._sendGuardUntil = Date.now() + SEND_GUARD_MS;
    if (this._state) {
      this._state.adjustBook(-base);
      this._state.save();
    }
    try {
      const result = await this.sphere.payments.send({
        recipient,
        amount: base.toString(),
        coinId: this.coin.coinId,
        memo,
      });
      if (result?.error) {
        log.error(`Send returned an error to ${recipient}: ${result.error}`);
        return { ambiguous: true, code: 'send-error', message: String(result.error) };
      }
      log.info(`Sent ${this.toWhole(base)} ${this.coin.symbol} to ${recipient} (${result?.status ?? 'ok'}).`);
      return result;
    } catch (err) {
      // The send threw AFTER we submitted the intent. It may already be certified
      // (e.g. CHECKPOINT_PERSIST_FAILED: "split burn certified …") or may have
      // failed outright — we cannot tell, so we NEVER auto-retry (double-pay guard)
      // and report it as ambiguous for the caller to record conservatively.
      const code = isSphereError(err) ? err.code : 'send-threw';
      log.warn(`Send to ${recipient} not confirmed (${code}) — NOT retrying (double-pay guard): ${fmtErr(err)}`);
      return { ambiguous: true, code, message: fmtErr(err) };
    }
  }

  /**
   * Release a bounty reward (minus fee) to its confirmed claimer. Gated by the
   * RELEASE_ENABLED master switch on top of every guard in `_send`.
   * @param {bigint} keepFloorBase escrow owed to OTHER bounties (co-mingling guard)
   */
  async release(recipient, base, memo, keepFloorBase = 0n) {
    if (!config.safety.releaseEnabled) {
      log.warn(`RELEASE_ENABLED=false — holding release of ${this.toWhole(base)} to ${recipient}.`);
      return { skipped: 'release-disabled' };
    }
    return this._send(recipient, base, memo, { keepFloorBase });
  }

  /** Refund a poster in full (no fee). Also gated by RELEASE_ENABLED (an outflow). */
  async refund(recipient, base, memo, keepFloorBase = 0n) {
    if (!config.safety.releaseEnabled) {
      log.warn(`RELEASE_ENABLED=false — holding refund of ${this.toWhole(base)} to ${recipient}.`);
      return { skipped: 'release-disabled' };
    }
    return this._send(recipient, base, memo, { keepFloorBase });
  }

  /** Withdraw accrued fees/tips to the owner. Escrow is always protected via keepFloor. */
  async sweepFees(recipient, base, memo, keepFloorBase = 0n) {
    return this._send(recipient, base, memo, { keepFloorBase });
  }

  // ── payment requests (the escrow-funding invoice) ────────────────────────────
  async requestPayment(recipient, whole, memo) {
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would request ${whole} ${this.coin.symbol} from ${recipient} (${memo}).`);
      return { success: false, dryRun: true };
    }
    try {
      const result = await this.sphere.payments.requests.create(recipient, {
        coinId: this.coin.coinId,
        amount: this.toBase(whole).toString(),
        memo,
      });
      if (result?.success) log.info(`Payment request sent to ${recipient} for ${whole} ${this.coin.symbol}.`);
      else log.warn(`Payment request to ${recipient} failed: ${result?.error ?? 'unknown'}`);
      return result;
    } catch (err) {
      log.error(`Payment request failed to ${recipient}: ${fmtErr(err)}`);
      return { success: false, error: fmtErr(err) };
    }
  }

  /** Decline an inbound payment request — nobody may pull funds FROM the escrow. */
  async declineInbound(prId) {
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would decline inbound payment request ${prId}.`);
      return { dryRun: true };
    }
    try {
      await this.sphere.payments.requests.decline(prId);
      return { success: true };
    } catch (err) {
      log.warn(`Could not decline payment request ${prId}: ${err?.message ?? err}`);
      return { error: fmtErr(err) };
    }
  }

  // ── messaging ────────────────────────────────────────────────────────────────
  async sendDM(recipient, content) {
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would DM ${recipient}: ${content.slice(0, 80)}…`);
      return { dryRun: true };
    }
    try {
      const dm = await this.sphere.communications.sendDM(recipient, content);
      log.info(`DM sent to ${recipient} (${String(dm?.id ?? '').slice(0, 10)}…).`);
      return dm;
    } catch (err) {
      log.error(`DM failed to ${recipient}: ${fmtErr(err)}`);
      return { error: fmtErr(err) };
    }
  }

  /** Publish a public broadcast (optional transparency heartbeat). Honours DRY_RUN. */
  async broadcast(content, tags = config.publish.broadcastTags) {
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would broadcast (${content.length} chars; tags ${tags.join(',')}).`);
      return { dryRun: true };
    }
    try {
      const msg = await this.sphere.communications.broadcast(content, tags);
      log.info(`Broadcast published (${String(msg?.id ?? '').slice(0, 10)}…; tags ${tags.join(',')}).`);
      return msg;
    } catch (err) {
      log.warn(`Broadcast failed: ${fmtErr(err)}`);
      return { error: fmtErr(err) };
    }
  }

  /** secp256k1 signature over `message` using the agent's chain key. */
  signMessage(message) {
    return this.sphere.signMessage(message);
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    try {
      await this.sphere.destroy?.();
      log.info('Sphere connection closed.');
    } catch (err) {
      log.warn(`Error during shutdown: ${fmtErr(err)}`);
    }
  }
}

export default SphereClient;
