# frani-bounty

### One wallet. Four strangers' money in it. No sub-accounts.

A bounty board is escrow, and escrow means somebody else's reward sits in your wallet
between "funded" and "released". Run two bounties at once and the wallet holds two
people's money in one undifferentiated pile. Unicity has no escrow primitive and the
SDK has no sub-accounts, so the separation between Mira's 4 UCT and Odell's 6 UCT is
not something the network provides. It is an invariant this code has to hold:

```
spendable − (this payout)  ≥  Σ escrow still owed to every OTHER bounty
```

recomputed **from the bounty book** on every single send — never read from a running
counter that could drift — and then re-checked a second time *inside* the guarded
send, against a freshly-read balance. A bug in the state machine cannot pay a worker
out of another poster's escrow, because the layer that moves the UCT does not trust
the layer that decided to move it.

| | |
|---|---|
| **Submission track** | **Payments and markets** — escrow and settlement |
| **Agentic** | Yes. It takes custody, releases, refunds, expires, reopens lapsed claims and re-drives held payouts on its own schedule. No human approves anything. |
| **Runs on AstridOS** | No — a Node.js daemon under `systemd` on Linux |
| **Live on** | Unicity **testnet2** as `@frani-bounty` |
| **Address** | `DIRECT://000078210c232971efeba3079685ffc379a3133da7f8a4d9e11c6d6b0e11fe2fc3cd6ba6fd15` |
| **Pubkey** | `02ab03d8984874b7f9c61c4aae7ea8fa953c12636fdcb60a14be0ecfa6befb5a6d` |
| **SDK** | `@unicitylabs/sphere-sdk` ^0.15.0 (`state-transition-sdk` 3.x) |
| **Verified on-network** | 7 bounties posted, 4 funded into escrow, **1 released to a worker** (4.9 UCT after the 0.1 UCT fee), **5 refunded in full** (6 UCT returned), 1 expired on its own funding window — every terminal state exercised, not just the happy one |
| **Owner / Creator** | Itachi · Made by **CRYPTFRANI** |

---

## Why this one is custodial, and says so

The rest of the CRYPTFRANI fleet leans away from custody. `@frani-agent` has no send
path at all; `@frani-agora` holds funds only transiently. This board holds them on
purpose, because a bounty without escrow is not a bounty — it is a promise. A worker
who spends three hours on a task needs to know the reward is *already committed*
before they start, and a poster needs to know it does not pay out until they confirm.
Escrow is the product. So the interesting question is not "does it avoid custody" but
**"what does it do when custody is under strain"**, and that is what the demo and the
test suite are built around.

Inbound is still non-custodial: `create` places a **payment request** in the poster's
own wallet (`payments.requests`). The board cannot pull funds — the poster's wallet
decides, or they simply transfer the reward and the board matches it to their draft.

---

## Held is not failed

The single most important distinction in the codebase. When the co-mingling guard
refuses a payout, three things are simultaneously true:

- **no funds moved** — the guarded send returned *before* debiting anything;
- **the promise stands** — the bounty reverts to its prior status, keeps its escrow,
  and gets a `settleRetry` marker;
- **the worker is not told it failed**, because it has not.

The periodic sweep then re-drives it. That is safe precisely *because* a held attempt
debited nothing, so re-driving it cannot double-pay. Contrast the other branch: a send
whose outcome is **ambiguous** (`CERTIFICATION_UNCONFIRMED` — the burn may already be
certified) is **never** retried and never claimed either way; the counterparty is told
to check their wallet and the operator is told what to verify. Three outcomes, three
different answers, and silence is not one of them.

```
guard refuses        → HELD    → revert · retry marker · sweep re-drives · nobody misinformed
send returns error   → FAILED  → revert · counterparty told plainly · nothing claimed
outcome ambiguous    → UNKNOWN → never resent · never claimed · operator flagged
```

---

## The lifecycle

```
 draft ──fund──▶ open ──claim──▶ claimed ──submit──▶ submitted ──confirm──▶ RELEASED
   │              │                 │                    │
   │ fund window  │ open expiry     │ claim window       │ confirm window
   ▼ elapses      ▼ (unclaimed)     ▼ (no proof)         ▼ (poster silent)
 EXPIRED        EXPIRED         reopens to open      AUTO-RELEASE to the worker
 (refund any    (refund          (claim lapses)      (published dispute policy)
  partial)       poster)
```

Every automatic transition is preceded by a reminder naming its deadline, so no
outcome arrives unannounced. Two asymmetries are deliberate and worth stating:

- **A poster cannot cancel out from under a worker.** `cancel` works on a draft or an
  unclaimed bounty. Once somebody holds a claim, the exits are confirm, reject-until-
  attempts-exhausted, the claim lapsing, or the operator's dispute door.
- **A silent poster does not get to strand the reward.** Past the confirmation window
  a submitted bounty **auto-releases to the worker** who demonstrably did the task.

**Fees:** 2%, taken from the reward **only on a successful release** — the worker gets
`reward − fee`. A refund, cancellation or expiry is charged **nothing**, ever. And the
fee sweep is bound by the same escrow floor as every other payout: the board cannot
withdraw its own earnings out of somebody's escrow either.

---

## See it under strain, in one command

```bash
npm install
npm run demo
```

`--demo` drives the real `bounty.js` state machine, the real ledger and the real
config against a **fake wallet**. It opens no socket and no wallet file, so — unlike
`whoami` — it is safe to run while the daemon is up.

- **Happy path** — Mira posts a 5 UCT bounty, funds it via the payment request in her
  own wallet, Vance claims it, submits, she confirms; 4.9 UCT to Vance, 0.1 kept.
- **Failure path** — Odell's 6 UCT payout comes due while part of the corpus is
  briefly unavailable. It is **refused**, and the demo prints the three facts of a
  hold side by side: 0 UCT moved, Mira's escrow still intact, Vance's counterpart not
  misinformed. The corpus recovers, the sweep pays it. Then Mira rejects a proof — the
  worker keeps his claim and his remaining attempts, the escrow never moves — and her
  attempt to cancel a claimed bounty is refused *to her face*.

It closes with every outbound move and the escrow floor each one had to clear.

---

## Talking to the board

DM `@frani-bounty` on testnet2. A leading `!` is optional.

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

Owner-only, from `OWNER_PUBKEY`, and **entirely absent** unless that is set —
non-owners get "unknown command", so the surface is never even revealed:

```
pause · resume · params · admin
resolve <id> release|refund · withdraw <amount> · blacklist <pubkey> [on|off]
```

`pause` freezes every outflow live, without a redeploy — and freezes it *as a hold*,
so refunds and releases queue up and go out on `resume` rather than being lost.

---

## Running it

```bash
npm install
cp .env.example .env      # optional — every value has a safe default

npm run whoami            # identity, address, balance
npm run doctor            # connectivity + config self-check
npm run status            # the live board report
npm run demo              # the offline walk-through (safe while running)
npm start                 # the autonomous daemon

npm test                  # four offline suites, 104 assertions
```

Node ≥ 22 (the SDK's live feed uses native `WebSocket`/`fetch`). First launch
generates a BIP39 identity, claims the nametag, and prints the recovery phrase
**once** before writing it to `wallet-data/` (gitignored, mode 0600). Back it up
offline, set `WALLET_PASSWORD` to encrypt it at rest, delete the directory to start
over. `wallet-data/` also holds the escrow ledger — never share or commit it.

> Do not run `whoami` / `doctor` / `status` while the service is up — each boots a
> second Sphere instance on the same wallet. Use `journalctl` or the DM `status`.
> `npm run demo` is the exception: it never opens a connection.

### As a service

A ready unit ships as [`frani-bounty.service`](frani-bounty.service):

```bash
sudo cp frani-bounty.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now frani-bounty
journalctl -u frani-bounty -f
```

`KillSignal=SIGINT` matters: the board treats SIGINT as a graceful close — stop
timers, persist the ledger, close the socket — rather than being hard-killed
mid-write.

### Configuration

Every knob has a conservative default, so an absent `.env` still runs a valid board.
Full annotated list in [`.env.example`](.env.example); the ones that change what the
board will agree to:

| Variable | Default | Meaning |
|---|---|---|
| `PROTOCOL_FEE_BPS` | `200` | fee on release, in basis points (200 = 2%); refunds are always free |
| `MIN_REWARD_UCT` / `MAX_REWARD_UCT` | `0.1` / `50` | per-bounty reward bounds |
| `MAX_TOTAL_ESCROW_UCT` | `500` | global custody ceiling — the board refuses to hold more |
| `FUND_WINDOW_HOURS` | `24` | time to fund a draft before it expires |
| `CLAIM_WINDOW_HOURS` | `72` | time to submit proof before a claim lapses |
| `CONFIRM_WINDOW_HOURS` | `120` | time for the poster to act before auto-release |
| `AUTO_RELEASE_ON_TIMEOUT` | `true` | confirm-timeout → the worker is paid |
| `RELEASE_ENABLED` | `true` | master outflow switch (owner `pause` flips it) |
| `OWNER_PUBKEY` | *(empty)* | empty = the admin surface does not exist |
| `DRY_RUN` | `false` | log every intended action, move nothing |

---

## Layout

```
src/
  bounty.js         the escrow state machine and every money move
  state.js          the ledger — bounties, escrow derived from the book, atomic writes
  sphere-client.js  SDK wiring + the three guarded outflow rails (release/refund/fees)
  agent.js          the loop: events, the periodic sweep, boot-time reconciliation
  demo.js           the offline walk-through (real state machine, fake wallet)
  money.js          exact BigInt base-unit math (no float touches an amount)
  config.js         every knob, frozen, defaulted
  index.js  reply.js  ratelimit.js  logger.js
  services/
    commands.js     the DM router (public + owner)
    delivery.js     the standing market service intent + optional heartbeat
wallet-data/        mnemonic + state.json + the escrow ledger — GITIGNORED, 0600
```

State is written temp-file-plus-rename, so a crash mid-write cannot leave a truncated
ledger. Every inbound DM id and transfer id is de-duplicated, and a transfer's
"handled" mark and its credit are written in a **single** save — so an interrupted
credit stays un-acked, the SDK redelivers it, and funds are retried rather than
silently stranded.

## Tests

```bash
npm test
```

**104 assertions across four offline suites** — no network, no wallet, no funds.

| Suite | What it pins |
|---|---|
| `test-escrow-custody-unit.mjs` | **43 assertions, 11 of which fail without the fix.** One bounty is never paid out of another's escrow: the floor is derived from the book and moves when the book moves; a payout that would breach it is refused *as held* (status reverted, retry marker written, nothing moved, nobody misinformed) and the sweep pays it once the corpus recovers; the fee falls on the release and never on the refund, and payouts and refunds are never crossed between worker and poster; an ambiguous send is neither retried nor claimed. It closes on the reason the outage bug matters **here**: a false zero would trip the escrow floor on *every* payout and strand every worker, and a false zero on the bootstrap path would inflate the corpus with UCT the board never earnt — money a payout could then be cleared against. |
| `test-retry-unit.mjs` | 30 assertions — a held settlement auto-recovers via the sweep, **exactly once**; an ambiguous one never re-sends |
| `test-silent-close-unit.mjs` | 18 assertions — a bounty that closes holding nothing still *says* so, to the party who asked |
| `test-dedup-unit.mjs` | 13 assertions — a transfer is acked only together with its credit; an interrupted credit retries and never strands |

The suites that move real UCT are deliberately **not** published: they embed an oracle
API key and read a wallet mnemonic. `.gitignore` keeps `test-*.mjs` ignored by default
and negates only the four offline files, so a new live test stays private unless
somebody opts it in.

---

## Sibling agents (CRYPTFRANI fleet, testnet2)

Five agents, five different positions on custody. That is the point of running five.

| Agent | Primitive | Custody |
|---|---|---|
| **@frani-bounty** | bounty escrow, poster vs worker — this one | **custodial, on purpose** |
| **@frani-agora** | signed quote → invoice → settlement certificate | transient |
| **@frani-treasury** | grants, loans, repayment reputation | its own funds, not yours |
| **@frani-agent** | market discovery, standing watches | none — no send path exists |
| **@market-digest** | scheduled signed market reports | none needed |

---

Runs on **testnet2** with test-only UCT. Not financial software; provided as-is.

MIT © Itachi (CRYPTFRANI) — see [LICENSE](LICENSE).
