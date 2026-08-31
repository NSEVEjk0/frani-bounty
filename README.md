# frani-bounty

A bounty board with custodial escrow on Unicity **testnet2**. Post a task with a
reward, and the board holds that reward until the poster confirms the work. It takes
custody, releases, refunds, expires and reopens lapsed claims on its own.

A bounty board *is* escrow, and escrow means somebody else's reward sits in your
wallet between "funded" and "released". Unicity has no escrow primitive and the SDK
has no sub-accounts, so keeping Mira's 4 UCT separate from Odell's 6 UCT is not
something the network does for you. It is one invariant this code holds:

```
spendable − (this payout)  ≥  Σ escrow still owed to every OTHER bounty
```

**Live as `@frani-bounty`.**
Address: `DIRECT://000078210c232971efeba3079685ffc379a3133da7f8a4d9e11c6d6b0e11fe2fc3cd6ba6fd15`
Pubkey: `02ab03d8984874b7f9c61c4aae7ea8fa953c12636fdcb60a14be0ecfa6befb5a6d`

---

## Track

**Payments and markets** — escrow and settlement

## Is it Agentic?

**Yes.** It takes custody, releases rewards, refunds in full, expires funding and
claim windows, reopens lapsed claims, auto-releases past a silent poster's deadline
and re-drives held payouts on its own schedule. No human approves anything.

## Runs on AstridOS?

**No** — a Node.js daemon under `systemd` on Linux.

## SDK features used

| Sphere SDK feature | How it's used here |
|---|---|
| `payments.requests` | `create` places a request in the **poster's own** wallet — the board cannot pull funds |
| `payments.send` | three guarded rails: release to a worker, refund to a poster, fee sweep |
| `payments.assets` | the live balance every payout is checked against, twice |
| Direct Messages | the whole interface: post, claim, submit, confirm, receipts, deadline reminders |
| Nametags | `@frani-bounty` |
| `mintFungibleToken` | capped opt-in seed mint only (`SELF_MINT_ENABLED`); escrow needs none |

---

## What makes it different

**The escrow floor is derived from the book, not from a counter.** It is recomputed
from the live bounty list on every single send — never read from a running total that
could drift — and then re-checked a second time *inside* the guarded send against a
freshly-read balance. A bug in the state machine cannot pay a worker out of another
poster's escrow, because the layer that moves the UCT does not trust the layer that
decided to move it. The board's own fee sweep is bound by the same floor.

**"Held is not failed."** When the guard refuses a payout, three things are true at
once: no funds moved, the promise stands (status reverted, escrow intact, retry marker
written), and the worker is **not** told it failed — because it hasn't. The sweep
re-drives it later, which is safe precisely because a held attempt debited nothing.
Three outcomes, three different answers, and silence is not one of them:

```
guard refuses        → HELD    → revert · retry marker · sweep re-drives · nobody misinformed
send returns error   → FAILED  → revert · counterparty told plainly · nothing claimed
outcome ambiguous    → UNKNOWN → never resent · never claimed · operator flagged
```

**The lifecycle protects both sides, asymmetrically and on purpose.**

```
 draft ──fund──▶ open ──claim──▶ claimed ──submit──▶ submitted ──confirm──▶ RELEASED
   │              │                 │                    │
   ▼ fund window  ▼ open expiry     ▼ claim window       ▼ confirm window elapses
 EXPIRED        EXPIRED          reopens to open      AUTO-RELEASE to the worker
```

- **A poster cannot cancel out from under a worker.** `cancel` works on a draft or an
  unclaimed bounty only. Once somebody holds a claim, the exits are confirm, reject
  until attempts run out, the claim lapsing, or the operator's dispute door.
- **A silent poster cannot strand the reward.** Past the confirmation window a
  submitted bounty auto-releases to the worker who demonstrably did the task.
- Every automatic transition is preceded by a reminder naming its deadline.

**Fees:** 2%, taken from the reward **only on a successful release**. A refund,
cancellation or expiry is charged nothing, ever.

---

## Try it without a wallet

```bash
npm install && npm run demo
```

Drives the real `bounty.js` state machine, the real ledger and the real config against
a **fake wallet** — no socket, no wallet file, safe while the daemon is up.

- **Happy path** — Mira posts a 5 UCT bounty, funds it through the payment request in
  her own wallet, Vance claims it, submits proof, she confirms: 4.9 UCT to Vance,
  0.1 kept.
- **Failure path** — Odell's 6 UCT payout comes due while part of the corpus is
  briefly unavailable. It is **refused**, and the demo prints the three facts of a hold
  side by side: 0 UCT moved, Mira's escrow intact, Vance's counterpart not misinformed.
  The corpus recovers and the sweep pays it. Then Mira rejects a proof (the worker
  keeps his claim and his remaining attempts) and her attempt to cancel a *claimed*
  bounty is refused to her face.

It closes with every outbound move and the escrow floor each one had to clear.

---

## Commands

DM `@frani-bounty`. A leading `!` is optional.

```
create <reward> <title>     post a bounty; the board requests the reward from your wallet
list · view <id> · mine     what's open · one bounty in full · yours, both sides
claim <id>                  take an open bounty
submit <id> <proof>         a link or a description
confirm <id>                (poster) accept → the reward releases
reject <id> [reason]        (poster) send it back; the worker may revise
cancel <id>                 (poster) draft or unclaimed only → full refund, no fee
boost <id> <amount>         top up a live bounty's reward
status · history · about · help
```

Owner-only, and **absent entirely** unless `OWNER_PUBKEY` is set (non-owners get
"unknown command", so the surface is never revealed):

```
pause · resume · params · admin
resolve <id> release|refund · withdraw <amount> · blacklist <pubkey> [on|off]
```

`pause` freezes every outflow live, without a redeploy — and freezes it *as a hold*,
so refunds and releases queue and go out on `resume` rather than being lost.

## Run it

```bash
npm install
cp .env.example .env      # optional — every value has a safe default

npm run doctor            # connectivity + config self-check
npm run status            # the live board report
npm run demo              # offline walk-through (safe while running)
npm start                 # the autonomous daemon
npm test                  # 104 assertions, four offline suites
```

Node ≥ 22. First launch generates a BIP39 identity and claims the nametag; the
recovery phrase prints **once** before landing in `wallet-data/` (gitignored, 0600),
which also holds the escrow ledger. Back it up, or set `WALLET_PASSWORD` to encrypt it
at rest.

> Don't run `whoami`/`doctor`/`status` while the service is up — each opens a second
> connection on the same wallet. Use `journalctl -u frani-bounty` or the DM `status`.
> `npm run demo` is the exception.

Deploy with the shipped unit: `sudo cp frani-bounty.service /etc/systemd/system/ &&
sudo systemctl enable --now frani-bounty`. `KillSignal=SIGINT` matters — the board
treats SIGINT as a graceful close: stop timers, persist the ledger, close the socket.

## Configuration

Every knob has a conservative default, so an absent `.env` still runs a valid board.
Full list in [`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `PROTOCOL_FEE_BPS` | `200` | fee on release (200 = 2%); refunds are always free |
| `MIN_REWARD_UCT` / `MAX_REWARD_UCT` | `0.1` / `50` | per-bounty reward bounds |
| `MAX_TOTAL_ESCROW_UCT` | `500` | global custody ceiling — the board refuses to hold more |
| `FUND_WINDOW_HOURS` | `24` | time to fund a draft before it expires |
| `CLAIM_WINDOW_HOURS` | `72` | time to submit proof before a claim lapses |
| `CONFIRM_WINDOW_HOURS` | `120` | time for the poster to act before auto-release |
| `AUTO_RELEASE_ON_TIMEOUT` | `true` | confirm-timeout → the worker is paid |
| `OWNER_PUBKEY` | *(empty)* | empty = the admin surface does not exist |
| `DRY_RUN` | `false` | log every intended action, move nothing |

## Structure

```
src/
  bounty.js         the escrow state machine and every money move
  state.js          the ledger — escrow derived from the book, atomic writes
  sphere-client.js  SDK wiring + the three guarded outflow rails
  agent.js          the loop: events, the periodic sweep, boot-time reconciliation
  demo.js           the offline walk-through
  money.js          exact BigInt base-unit math — no float touches an amount
  services/         commands.js (DM router) · delivery.js (market intent)
```

State is written temp-file-plus-rename. A transfer's "handled" mark and its credit are
written in a **single** save, so an interrupted credit stays un-acked, the SDK
redelivers it, and funds are retried rather than silently stranded.

## Tests

```bash
npm test   # 104 assertions across four offline suites — no network, no wallet
```

| Suite | What it pins |
|---|---|
| `test-escrow-custody-unit.mjs` | 43 assertions, **11 fail without the fix**: one bounty is never paid out of another's escrow. The floor is derived from the book and moves when the book moves; a breach is refused *as held* and the sweep pays it once the corpus recovers; the fee falls on the release and never the refund. |
| `test-retry-unit.mjs` | 30 assertions — a held settlement auto-recovers via the sweep **exactly once**; an ambiguous one never re-sends. |
| `test-silent-close-unit.mjs` | 18 assertions — a bounty that closes holding nothing still *says* so, to the party who asked. |
| `test-dedup-unit.mjs` | 13 assertions — a transfer is acked only together with its credit. |

Suites that move real UCT are deliberately not published — they read a mnemonic.

## Verified on-network

7 bounties posted, 4 funded into escrow, **1 released to a worker** (4.9 UCT after the
0.1 fee), **5 refunded in full** (6 UCT returned), 1 expired on its own funding window
— every terminal state exercised, not just the happy one.

---

Owner / Creator: **Itachi** · Made by **CRYPTFRANI**
Runs on testnet2 with test-only UCT. Not financial software; provided as-is.
MIT — see [LICENSE](LICENSE).
