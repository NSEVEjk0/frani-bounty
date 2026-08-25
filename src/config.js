/**
 * frani-bounty — central configuration
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * All runtime settings live here. Values come from environment variables
 * (optionally loaded from a local .env file), each with a safe, conservative
 * default. The exported object is frozen so nothing mutates config at runtime.
 *
 * frani-bounty is a CUSTODIAL ESCROW: posters entrust reward funds to it and it
 * must only ever pay them out to the right party. So it is deliberately timid
 * out of the box — modest reward bounds, a global custody cap, generous
 * confirmation windows before any auto-release, and a RELEASE_ENABLED
 * kill-switch. Loosen it on purpose via .env — never by accident.
 */

import { createLogger } from './logger.js';

const log = createLogger('config');

// Load .env if present (Node >=20.12). Never fatal if the file is missing.
try {
  process.loadEnvFile(process.env.ENV_FILE || '.env');
} catch {
  // No .env file — rely on real environment variables and defaults.
}

// ── small typed env helpers ────────────────────────────────────────────────
const str = (key, def) => {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
};
const int = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) {
    log.warn(`Invalid integer for ${key}="${v}", using default ${def}`);
    return def;
  }
  return n;
};
const num = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) {
    log.warn(`Invalid number for ${key}="${v}", using default ${def}`);
    return def;
  }
  return n;
};
const bool = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
};
const list = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const parts = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : def;
};

// Nametag: strip a leading '@' and lowercase, since the SDK expects the bare form.
// AGENT_NAME is the documented alias for NAMETAG (AGENT_NAME wins if both are set).
const rawNametag = str('AGENT_NAME', str('NAMETAG', 'frani-bounty'))
  .replace(/^@/, '')
  .trim()
  .toLowerCase();

// Owner admin key: the on-network pubkey allowed to issue protected admin
// commands over DM (resolve/pause/params/sweep-fees/…). EMPTY BY DEFAULT → the
// admin surface is disabled entirely (safe). Set OWNER_PUBKEY to your
// controlling identity's chain pubkey to enable it.
const ownerPubkey = str('OWNER_PUBKEY', '').trim().toLowerCase();

const config = Object.freeze({
  // ── Identity / branding ──────────────────────────────────────────────────
  nametag: rawNametag,
  owner: 'Itachi',
  brand: 'CRYPTFRANI',

  // ── Storage ────────────────────────────────────────────────────────────
  walletDir: str('WALLET_DIR', './wallet-data'),
  walletFileName: str('WALLET_FILE', 'wallet.json'),
  password: str('WALLET_PASSWORD', undefined), // undefined => plaintext on disk

  // ── Network (testnet2) ───────────────────────────────────────────────────
  network: str('UNICITY_NETWORK', str('NETWORK', 'testnet2')), // UNICITY_NETWORK is the documented alias
  oracleApiKey: str('ORACLE_API_KEY', 'sk_ddc3cfcc001e4a28ac3fad7407f99590'),
  walletApiUrl: str('WALLET_API_URL', 'https://wallet-api.unicity.network'),
  coinSymbol: str('COIN_SYMBOL', 'UCT'),

  // ── Bounty & escrow policy — the rules the board runs by ──────────────────
  // Every whole-UCT knob is a hard constraint enforced with exact BigInt math.
  // The custodial invariant (spendable ≥ Σ live escrow) is re-checked
  // independently in the guarded send before any UCT leaves the wallet, so no
  // bug in the state machine can pay one bounty's reward out of another's escrow.
  bounty: Object.freeze({
    // Protocol fee, in basis points (1% = 100 bps). Taken out of the reward ONLY
    // on a successful RELEASE (the claimer receives reward − fee; the poster
    // funds exactly the reward). Refunds are ALWAYS full — no fee is ever taken
    // on a refund, cancellation, or expiry.
    feeBps: int('PROTOCOL_FEE_BPS', 200), // 2%

    // Reward bounds for a single bounty (whole UCT).
    minRewardWhole: num('MIN_REWARD_UCT', 0.1),
    maxRewardWhole: num('MAX_REWARD_UCT', 50),

    // Global custody cap: the board will not hold more than this in live escrow
    // across all bounties combined. A hard ceiling on total exposure.
    maxTotalEscrowWhole: num('MAX_TOTAL_ESCROW_UCT', 500),

    // Per-account activity caps (anti-abuse; ties up finite escrow fairly).
    maxOpenBountiesPerPoster: int('MAX_OPEN_BOUNTIES_PER_POSTER', 10),
    maxActiveClaimsPerClaimer: int('MAX_ACTIVE_CLAIMS_PER_CLAIMER', 5),
    maxProofAttempts: int('MAX_PROOF_ATTEMPTS', 3),

    // Lifecycle windows (hours unless noted). Chosen conservatively: the poster
    // and claimer always get generous, clearly-announced time before anything
    // auto-resolves, and every auto-resolution is preceded by a reminder.
    fundWindowHours: int('FUND_WINDOW_HOURS', 24), // DRAFT → funded, else auto-expire (refund any partial)
    claimWindowHours: int('CLAIM_WINDOW_HOURS', 72), // CLAIMED → proof, else the claim lapses & reopens
    confirmWindowHours: int('CONFIRM_WINDOW_HOURS', 120), // SUBMITTED → poster acts, else AUTO-RELEASE to claimer
    openExpiryDays: int('OPEN_EXPIRY_DAYS', 30), // OPEN & unclaimed this long → expire & refund poster
  }),

  // ── Economic safety rails ────────────────────────────────────────────────
  safety: Object.freeze({
    // Global observe-only kill-switch: log intended actions, touch nothing.
    dryRun: bool('DRY_RUN', false),
    // Master outflow switch. If false, the board still accepts escrow and runs
    // the state machine but pays NOTHING out (releases & refunds are held) —
    // an instant freeze on all outflow without a redeploy. Owner `pause` flips it.
    releaseEnabled: bool('RELEASE_ENABLED', true),
    // On a confirm-timeout (proof submitted, poster silent past the window),
    // auto-release the reward to the claimer. This is the configured dispute
    // policy. If false, such bounties are escalated to the owner instead.
    autoReleaseOnConfirmTimeout: bool('AUTO_RELEASE_ON_TIMEOUT', true),
    // An escrow board earns fees, it doesn't fund itself — self-mint is OFF by
    // default. Kept only as an optional convenience for local demos/testing.
    selfMintEnabled: bool('SELF_MINT_ENABLED', false),
    selfMintAmountWhole: num('SELF_MINT_AMOUNT', 0),
    // Optional operational floor of the board's OWN (non-escrow) funds that is
    // never spent. 0 by default — the only protected balance is live escrow.
    minBalanceFloorWhole: num('MIN_BALANCE_FLOOR_UCT', 0),
    // Politeness / anti-spam (relay protection; not a money control).
    maxDmsPerHour: int('MAX_DMS_PER_HOUR', 40),
    maxActionsPerHour: int('MAX_ACTIONS_PER_HOUR', 80),
    // Global cap on the NUMBER of outbound payouts per hour (rate, not amount).
    maxReleasesPerHour: int('MAX_RELEASES_PER_HOUR', 30),
  }),

  // ── Owner admin (protected) ──────────────────────────────────────────────
  admin: Object.freeze({
    ownerPubkey,
    enabled: ownerPubkey.length > 0,
  }),

  // ── Housekeeping cadences ────────────────────────────────────────────────
  schedule: Object.freeze({
    // How often to sweep bounties for expiries, claim/confirm timeouts and
    // due-soon reminders (ms).
    sweepMs: int('SWEEP_MS', 15 * 60_000),
    // Cadence for the incoming-transfer / DM safety-net receive() poll (ms).
    receivePollMs: int('RECEIVE_POLL_MS', 45_000),
  }),

  // ── Public advert (the service intent on the market board) ────────────────
  publish: Object.freeze({
    serviceIntentEnabled: bool('SERVICE_INTENT_ENABLED', true),
    intentExpiresInDays: int('INTENT_EXPIRES_DAYS', 7),
    serviceDescription: str(
      'SERVICE_DESCRIPTION',
      'frani-bounty: an autonomous bounty board & custodial escrow on Unicity testnet2. ' +
        'DM @frani-bounty `create <reward> <title>` to post a bounty and fund the reward into escrow; ' +
        'workers `claim <id>`, do the work, `submit <id> <proof>`; you `confirm <id>` and the reward is ' +
        'released automatically (2% protocol fee). Refunds on cancel/expiry are always full. ' +
        'Transparent rules, `status` any time. Run by CRYPTFRANI.',
    ),
    // Optional public heartbeat: broadcast a short board-status line each sweep.
    broadcastEnabled: bool('BROADCAST_ENABLED', false),
    broadcastTags: Object.freeze(list('BROADCAST_TAGS', ['bounty', 'escrow', 'unicity'])),
  }),

  logLevel: str('LOG_LEVEL', 'info'),
});

export default config;
