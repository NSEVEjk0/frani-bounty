# frani-bounty

**An autonomous bounty board & custodial escrow for micro-bounties on Unicity testnet2.**

**Track:** Autonomous agents — escrow and settlement
**Agentic:** Yes — it takes custody, releases and refunds on its own rules, with no human in the loop
**Runs on AstridOS:** No — a Node.js daemon under `systemd` on Linux
**Status:** Live on testnet2 as `@frani-bounty`. Verified end-to-end on-network: 7 bounties posted, 4 funded into escrow, 1 released to a worker (4.9 UCT after a 0.1 UCT protocol fee), 5 refunded in full (6 UCT returned), 1 expired on its own funding window.
**SDK:** `@unicitylabs/sphere-sdk` ^0.15.0 (`state-transition-sdk` 3.x)

Post a task, fund a reward into escrow, and let workers claim it. When the work is
done and confirmed, the reward is released automatically — minus a small protocol
fee. If a bounty is cancelled or expires, the poster is refunded in full. Every
interaction happens over an encrypted direct message; the board runs unattended as
a background daemon and holds funds in custody the whole way through.

- **Live on Unicity testnet2 as** `@frani-bounty`
- **Address:** `DIRECT://000078210c232971efeba3079685ffc379a3133da7f8a4d9e11c6d6b0e11fe2fc3cd6ba6fd15`
- **Pubkey:** `02ab03d8984874b7f9c61c4aae7ea8fa953c12636fdcb60a14be0ecfa6befb5a6d`

> **Owner / Creator: Itachi** · Made by **CRYPTFRANI**

---

## What it does

frani-bounty is a **custodial escrow with a state machine wrapped around it**. Anyone
on the network can:

1. **Post a bounty** and fund its reward into escrow.
2. **Claim** an open bounty to work on it.
3. **Submit proof** of the finished work.
4. Have the poster **confirm** — which **releases the reward automatically** to the
   worker (minus the protocol fee).

The board holds the reward the entire time, so a worker knows the money is really
there before they start, and a poster knows it only pays out once they confirm (or
the confirmation window elapses). Nobody has to trust the counterparty — they trust
the escrow and its published, unchanging rules.

It is **earn-only with strict, controlled outflow**: UCT leaves the wallet through
exactly three paths — a **release** to a confirmed worker, a **refund** to a poster,
or an owner **fee withdrawal** — and never any other way.

---

## The bounty lifecycle

```
 draft ──fund──▶ open ──claim──▶ claimed ──submit──▶ submitted ──confirm──▶ RELEASED
   │              │                 │                    │
   │ fund window  │ open expiry     │ claim window       │ confirm window
   ▼ elapses      ▼ (unclaimed)     ▼ (no proof)         ▼ (poster silent)
 EXPIRED        EXPIRED         reopens to open      AUTO-RELEASE to worker
 (refund any    (refund          (claim lapses,      (the configured dispute
  partial)       poster)          bounty reopens)     policy — see below)
```

- **draft** — created, waiting for the poster to fund the reward into escrow. A draft
  accumulates partial funding and flips to **open** the moment it is fully funded.
- **open** — funded and claimable. Any worker (except the poster) may claim it.
- **claimed** — a worker is on it and has a window to submit proof.
- **submitted** — proof is in; the poster is asked to confirm or reject.
- **released / refunded / expired / cancelled** — terminal. The reward has either
  been paid to the worker or returned to the poster.

Every automatic transition (expiry, claim lapse, confirm-timeout) is **preceded by a
reminder** with a clearly stated deadline. Nobody is ever surprised.

### Dispute policy

If proof is submitted and the **poster goes silent** past the confirmation window,
the reward **auto-releases to the worker** who did the work. This is deliberate: the
worker demonstrably did the task, and an unresponsive poster shouldn't be able to
strand the reward. An operator can also step in and `resolve` a bounty either way.

### Fees & refunds

- **Protocol fee: 2%**, taken out of the reward **only on a successful release**. The
  worker receives `reward − fee`; the poster funds exactly the reward.
- **Refunds are always full.** No fee is ever taken on a cancellation, an expiry, or
  a refund of any kind.

_Example: a 5 UCT bounty pays the worker 4.9 UCT on release (0.1 UCT fee). Cancelled
or expired, the poster gets all 5 UCT back._

---

## Talking to the board

Everything is a direct message to `@frani-bounty`. A leading `!` is optional
(`!create` == `create`).

### Anyone

| Command | What it does |
|---|---|
| `create <reward> <title>` | Post a bounty and fund the reward into escrow |
| `list` | Show the bounties open right now |
| `view <id>` | Full detail of one bounty |
| `claim <id>` | Take an open bounty |
| `submit <id> <proof>` | Submit your work (a link or a description) |
| `confirm <id>` | *(poster)* accept the proof → release the reward |
| `reject <id> [reason]` | *(poster)* reject the proof → the worker may resubmit |
| `cancel <id>` | *(poster)* cancel a draft/open bounty → full refund |
| `boost <id> <amount>` | Add to a live bounty's reward |
| `mine` | Bounties you posted or are working on |
| `status` | Board-wide figures & rules |
| `history` | Your recent activity on the board |
| `about` · `help` | What this is / the command list |

### Funding a bounty

When you `create` a bounty, the board sends you a **payment request** for the reward.
Approve it, or simply **send the UCT to `@frani-bounty`** — either way the board
matches the incoming funds to your bounty, and it goes live once fully funded.
Overpayment is kept as a tip; underpayment accumulates until the reward is met.

### Owner-only

Disabled entirely unless `OWNER_PUBKEY` is set to the operator's identity. Then, over
DM from that identity:

| Command | What it does |
|---|---|
| `pause` · `resume` | Freeze / unfreeze **all** outflow instantly (no redeploy) |
| `resolve <id> release\|refund` | Settle a bounty either way |
| `withdraw <amount>` | Sweep accrued fees/tips to the owner |
| `blacklist <pubkey> [on\|off]` | Block / unblock an account |
| `params` | Dump the active policy knobs |
| `admin` | The owner command list |

---

## Safety model

The board holds other people's money, so the design is conservative by construction:

- **Custody invariant — `spendable ≥ Σ live escrow`.** The total held on behalf of all
  bounties is computed from the bounty records themselves (never a counter that could
  drift), and every payout is checked against it.
- **Co-mingling guard.** Before any UCT leaves the wallet, the guarded send re-checks —
  independently of the state machine — that the payment cannot drop the balance below
  the escrow still owed to *other* bounties. A bug in the lifecycle logic therefore
  **cannot** pay one bounty's reward out of another's escrow.
- **Crash-safety / no double-pay.** The exact amount in flight and an interim status are
  persisted *before* every send. If the process dies mid-send, boot recovery marks the
  bounty done-but-unconfirmed and **never resends** (the burn may already be certified),
  then flags the operator to verify against the wallet.
- **Honest accounting.** A send the board can't confirm is reported as "network
  confirmation pending" to the counterparty — never claimed as landed, never claimed as
  failed.
- **Kill-switches.** `RELEASE_ENABLED=false` (or the owner `pause` command) freezes all
  outflow instantly while still accepting escrow. `DRY_RUN=true` logs every intended
  action and moves nothing.
- **Guard rails.** Reward bounds, a global custody ceiling, per-account activity caps, a
  proof-attempt limit, a payout rate limit, and an optional operational balance floor —
  all enforced with exact BigInt math in the token's smallest unit (no floats).
- **Anti-abuse.** Per-account rate limiting on DMs and actions, plus a blacklist.

---

## Running it

Requires **Node.js ≥ 22**.

```bash
npm install
cp .env.example .env      # optional — every value has a safe default
npm start                 # start the daemon
```

### One-shot modes

```bash
npm run whoami            # print identity + balance, then exit
npm run doctor            # connectivity / config self-check, then exit
npm run status            # print the live board status report, then exit
npm run demo              # walk the escrow lifecycle & fee math (no funds move)
```

On first start the board **creates a wallet**, prints its BIP39 recovery phrase
**once** (back it up offline), saves it to `wallet-data/` (mode `0600`), and registers
its nametag. The `wallet-data/` directory holds the mnemonic, the device id, and the
escrow ledger — it is git-ignored and must never be shared or committed.

### Configuration

All settings are environment variables with conservative defaults; see
[`.env.example`](.env.example) for the full annotated list. The knobs you're most
likely to touch:

| Variable | Default | Meaning |
|---|---|---|
| `OWNER_PUBKEY` | *(empty)* | Enable the owner admin surface for this pubkey |
| `PROTOCOL_FEE_BPS` | `200` | Protocol fee in basis points (200 = 2%) |
| `MIN_REWARD_UCT` / `MAX_REWARD_UCT` | `0.1` / `50` | Per-bounty reward bounds |
| `MAX_TOTAL_ESCROW_UCT` | `500` | Global custody ceiling across all bounties |
| `FUND_WINDOW_HOURS` | `24` | Time to fund a draft before it expires |
| `CLAIM_WINDOW_HOURS` | `72` | Time to submit proof before a claim lapses |
| `CONFIRM_WINDOW_HOURS` | `120` | Time for the poster to act before auto-release |
| `AUTO_RELEASE_ON_TIMEOUT` | `true` | Confirm-timeout → auto-release to the worker |
| `RELEASE_ENABLED` | `true` | Master outflow switch (owner `pause` flips it) |
| `DRY_RUN` | `false` | Observe-only: log intended actions, move nothing |

---

## Running as a service (systemd)

A ready unit is included at [`frani-bounty.service`](frani-bounty.service):

```bash
sudo cp frani-bounty.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now frani-bounty
journalctl -u frani-bounty -f          # follow the logs
```

`systemctl stop`/`restart` sends `SIGINT`, so the board runs its graceful shutdown
(stop timers → persist state → close the connection) rather than being hard-killed.
The V8 heap is capped at ~500 MB; the whole footprint (deps included) is well under
that.

---

## Architecture

A small, modular ESM codebase — event-driven, no busy loops, tiny footprint.

| File | Responsibility |
|---|---|
| `src/index.js` | Entry point; daemon + one-shot modes (`--whoami/--doctor/--status/--demo`) |
| `src/agent.js` | The autonomous loop: event subscriptions, periodic sweep, safety-net polling, crash recovery |
| `src/bounty.js` | The escrow state machine and every money move (release / refund) |
| `src/sphere-client.js` | Sphere SDK wrapper: identity, balance (lag-free book), guarded sends |
| `src/state.js` | Atomic JSON-backed ledger: bounties, escrow accounting, dedup, stats |
| `src/services/commands.js` | The DM command router (public + owner) |
| `src/services/delivery.js` | Public service-intent advert + optional status heartbeat |
| `src/config.js` | Central configuration from the environment |
| `src/money.js` | Exact BigInt money math (dependency-free) |
| `src/ratelimit.js`, `src/reply.js`, `src/logger.js` | Rate limiting, outbound DM helper, logging |

State lives in `wallet-data/state.json`, written atomically (temp file + rename). All
money is stored as base-unit decimal strings and only ever parsed through BigInt.

---

## Tests

```bash
npm test
```

Four offline suites — no network, no wallet, no funds:

| Suite | What it pins |
|---|---|
| `test-balance-outage-unit.mjs` | a wallet-api outage is never read as a zero escrow balance — 21 assertions, 7 of which fail without the fix |
| `test-silent-close-unit.mjs` | a bounty that closes holding nothing still *says* so — 18 assertions, 6 of which fail without the fix |
| `test-dedup-unit.mjs` | the same payment is never credited twice |
| `test-retry-unit.mjs` | a release that certified ambiguously is never re-sent (no double-pay) |

The suites that move real UCT are deliberately **not** published: they embed an oracle
API key and read a wallet mnemonic. `.gitignore` keeps `test-*.mjs` ignored by default and
negates only the offline ones, so a new live test stays private unless someone opts it in.

---

## License

MIT © Itachi (CRYPTFRANI) — see [LICENSE](LICENSE).
