# x402 Stellar Channels — Design Spec

**Date:** 2026-03-17
**Status:** Approved
**Context:** [Slack thread](https://stellarfoundation.slack.com/archives/C09R7495RDF/p1773445997072879) | [Ideas repo](https://github.com/stellar-experimental/ideas/tree/main/x402-zero-latency)

---

## Problem

[x402](https://www.x402.org/) requires an on-chain transaction + verification loop for every API call. For AI agents making dozens of calls in a single workflow, this compounds to minutes of cumulative latency — making x402 impractical for iterative, high-frequency agentic use cases.

## Solution

Implement a **unidirectional payment channel** using a Soroban smart contract. The agent deposits USDC once (open), signs off-chain auth entries per request (zero on-chain overhead), and settles once (close). N requests = 2 on-chain transactions total.

The off-chain state uses Stellar's existing `SorobanAuthorizationEntry` signing mechanism — the same primitive current x402 clients already use — making the client experience backwards-compatible. The client signs an auth entry for `channel_contract.update_state()` instead of `token.transfer()`.

---

## Scope

- Soroban contract: channel lifecycle + full dispute mechanism
- TypeScript demo: server, client, facilitator (standalone, not extending x402-stellar)
- Benchmark: vanilla x402 vs. channel x402 on Stellar testnet
- Testnet setup script: creates funded accounts, deploys contract
- Documentation for sharing with the Stellar ecosystem

---

## Repository Structure

```
x402-stellar-channels/
├── contract/                    # Soroban Rust contract
│   ├── src/
│   │   ├── lib.rs               # Contract entry point + public interface
│   │   ├── channel.rs           # Channel state machine
│   │   ├── dispute.rs           # Dispute resolution logic
│   │   └── types.rs             # Shared data types
│   └── Cargo.toml
├── demo/                        # TypeScript demo
│   ├── src/
│   │   ├── server/              # Paid API server (exact + channel schemes)
│   │   ├── client/              # Agent client (channel lifecycle + request logic)
│   │   ├── facilitator/         # Manages open/close on-chain
│   │   └── benchmark/           # Benchmark runner + timing instrumentation
│   ├── package.json
│   └── tsconfig.json
├── scripts/
│   ├── setup-testnet.ts         # Create funded testnet accounts, deploy contract
│   └── deploy-contract.ts
├── docs/
│   └── superpowers/specs/
│       └── 2026-03-17-x402-stellar-channels-design.md
└── README.md
```

---

## Soroban Contract

### On-chain state (per channel)

```rust
pub struct Channel {
    pub id:               BytesN<32>,
    pub agent:            Address,
    pub server:           Address,
    pub asset:            Address,       // USDC token contract
    pub deposit:          i128,
    pub iteration:        u64,           // latest agreed iteration
    pub agent_balance:    i128,
    pub server_balance:   i128,
    pub status:           ChannelStatus,
    pub dispute_state:    Option<ChannelState>,
    pub observation_end:  Option<u32>,   // ledger sequence when dispute window closes
}

pub enum ChannelStatus { Open, Closing, Closed }

pub struct ChannelState {               // the off-chain signed payload
    pub channel_id:       BytesN<32>,
    pub iteration:        u64,
    pub agent_balance:    i128,
    pub server_balance:   i128,
}
```

### Contract functions

| Function | Caller | Behavior |
|---|---|---|
| `open_channel(server, asset, deposit)` | Agent | Transfers `deposit` from agent into contract escrow; returns `channel_id` |
| `close_channel(channel_id, state, agent_auth, server_auth)` | Either | Both auth entries present → immediate settlement; pays out `agent_balance` and `server_balance` |
| `initiate_dispute(channel_id, state, auth)` | Either | Stores state, sets `observation_end = current_ledger + OBSERVATION_WINDOW` (~500 ledgers ≈ 42 min), status → `Closing` |
| `resolve_dispute(channel_id, state, agent_auth, server_auth)` | Either | Before `observation_end` only; accepted only if `state.iteration > dispute_state.iteration` |
| `finalize_dispute(channel_id)` | Anyone | After `observation_end`; settles using the highest-iteration accepted state |

### Off-chain auth entry (per request)

The client signs a `SorobanAuthorizationEntry` targeting:
```
channel_contract.update_state(channel_id, iteration, agent_balance, server_balance)
```

- `signature_expiration_ledger` is set to a far-future ledger (channel lifetime), not the 1–2 ledger window used for immediate transactions
- The SDK sets this automatically when constructing channel auth entries
- The contract enforces `iteration > stored_iteration` — older entries cannot be submitted

---

## x402 Protocol Integration

### 402 Response (server advertises channel support)

```json
{
  "schemes": [
    {
      "scheme": "exact",
      "price": "0.001",
      "asset": "USDC"
    },
    {
      "scheme": "channel",
      "price": "0.001",
      "asset": "USDC",
      "channelParams": {
        "contractId": "C...",
        "facilitatorUrl": "http://localhost:3002",
        "minDeposit": "0.10",
        "observationWindow": 500
      }
    }
  ]
}
```

### Per-request payment header (client → server)

```json
{
  "scheme": "channel",
  "channelId": "abc123...",
  "iteration": 42,
  "agentBalance": "0.958",
  "serverBalance": "0.042",
  "authEntry": "<XDR-encoded SorobanAuthorizationEntry for update_state(...)>"
}
```

### Server-side verification (fully local, no chain)

```
1. Parse channelId → look up channel in in-memory open-channels map
2. Check iteration > channel.lastIteration
3. Check agentBalance + serverBalance == channel.deposit
4. Check serverBalance - channel.lastServerBalance == price
5. Verify authEntry signature against agent's public key
→ All pass: serve response, update stored state
→ Any fail: 402
```

### Payment response header (server → client)

```json
{
  "scheme": "channel",
  "channelId": "abc123...",
  "iteration": 42,
  "serverAuthEntry": "<XDR SorobanAuthorizationEntry — server's counter-auth>"
}
```

Both parties hold the latest mutually-signed state. Either can submit it on-chain for coordinated close or dispute.

---

## Benchmark

Runs both modes against the same Stellar testnet, same server, N requests.

### Expected output

```
=== x402 Channels Benchmark — Stellar Testnet ===

--- Vanilla x402 (exact scheme, 20 calls) ---
  Call  1:  5,312ms  ✓
  Call  2:  4,988ms  ✓
  ...
  Call 20:  5,102ms  ✓
  Total: 101,840ms | Per-call avg: 5,092ms

--- Channel x402 (20 calls) ---
  Channel open:   6,234ms
  Call  1:           11ms  ✓
  ...
  Call 20:           12ms  ✓
  Channel close:  5,117ms
  Total: 11,582ms | Per-call avg (excl. open/close): 10ms

--- Summary ---
  Break-even point: 3 calls
  Total speedup (20 calls): 8.8x
  Per-call speedup (after open): 509x
```

### Benchmark files

- `benchmark/run.ts` — orchestrates both runs, prints results, saves `benchmark-results.json`
- `benchmark/vanilla.ts` — vanilla x402 run using exact scheme
- `benchmark/channel.ts` — channel run: open → N calls → close
- Both share a `TimedApiClient` with per-call timing instrumentation

---

## Testnet Setup

`scripts/setup-testnet.ts` (one command: `pnpm setup:testnet`):

1. Creates 3 Stellar testnet keypairs: agent, server, facilitator
2. Funds all three via Friendbot
3. Deploys the channel Soroban contract
4. Writes all keys + `CONTRACT_ID` to `.env.testnet`

---

## Security Properties

**Agent protection:** deposit exposure is bounded; agent can unilaterally close and recover unspent funds if server goes offline.

**Server protection:** server holds the latest signed auth entry at all times; can initiate dispute and claim accumulated payments if agent disappears.

**Replay protection:** contract enforces `iteration > stored_iteration`; once a higher iteration is on-chain, all lower ones are invalid.

**Dispute protection:** observation window (~42 min default) gives the other party time to submit a higher-iteration state before funds are finalized.

---

## What This Is Not

- Not a general-purpose L2 rollup
- Not bidirectional (agent → server only; server never pays agent)
- Not suitable for one-off API calls (break-even at ~3 calls; use `exact` for fewer)
- Not a replacement for improving Stellar's base throughput

---

## References

- [x402-zero-latency ideas doc](https://github.com/stellar-experimental/ideas/tree/main/x402-zero-latency)
- [x402-stellar (vanilla implementation)](https://github.com/stellar/x402-stellar)
- [Starlight paper](https://stellar.org/blog/developers/starlight-a-layer-2-payment-channel-protocol-for-stellar)
- [PrivateX402 proposal](https://ethresear.ch/t/privatex402-privacy-preserving-payment-channels-for-multi-agent-ai-systems/24151)
