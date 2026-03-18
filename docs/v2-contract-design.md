# v2 Contract Design — Simplified Unidirectional Channels

Design document for the next iteration of the x402 payment channel contract, incorporating feedback from the internal #x402 thread (March 2026). The primary input comes from Tomer's protocol design proposals, validated against the Tempo TempoStreamChannel.sol reference implementation.

## Context

The v1 contract (`contract/src/`) works and powers the live demo. It treats the channel as roughly symmetric — either party can initiate disputes, and `close_channel` requires both signatures. This is more machinery than a unidirectional channel needs.

Tomer's core observation: since payments only flow one direction (agent to server) and commitments are monotonically increasing, the protocol can be dramatically simplified.

## Design Principles

1. **Commitments flow one direction** — agent signs, server counter-signs. The server always holds the highest-value state for itself.
2. **The server can always close immediately** — monotonically increasing commitments mean there's no incentive for the server to submit an outdated state. No observation window needed on this path.
3. **Only the agent needs a dispute/force-close path** — and it should be merged with the sender close path. If the server disappears, the agent gets a full refund after a grace period.
4. **Full refund fallback** — the agent's force-close path doesn't submit a state at all. It just starts a timer. If the server doesn't settle within the window, the agent reclaims the entire deposit.

## v1 vs v2 Comparison

### v1 (current) — 6 entry points

```
open_channel(agent, agent_pubkey, server, server_pubkey, asset, deposit, nonce) → channel_id
close_channel(channel_id, state, agent_sig, server_sig)
keep_alive(channel_id)
initiate_dispute(channel_id, state, sig, is_agent)
resolve_dispute(channel_id, state, agent_sig, server_sig)
finalize_dispute(channel_id)
```

**Issues:**
- `close_channel` requires both agent + server signatures. The server already has the agent's signature from the off-chain state exchange, so this works, but it means the close path requires the server to have collected counter-signatures.
- `initiate_dispute` accepts either party via `is_agent` flag. The server never needs to dispute — it can just call `close_channel` with the latest mutual state.
- `resolve_dispute` + `finalize_dispute` add complexity for a scenario (server-initiated dispute) that doesn't arise in practice.
- One contract instance holds many channels via `channel_id` keys, adding parameter noise to every call.
- Custom 72-byte message format for signing instead of leveraging Soroban's native auth.

### v2 (proposed) — 3 entry points

```
open(agent, agent_pubkey, server, server_pubkey, asset, deposit)
settle(state, agent_sig)                    — server calls, immediate payout
force_close()                               — agent calls, starts grace period
                                              server can still settle() during window
                                              after window: agent reclaims full deposit
```

## Detailed Design

### Contract Scoping

Each contract instance IS one channel. Deploy a new contract per channel. This eliminates:
- `channel_id` parameter from every call
- `channel_id` in the signed state message
- The `nonce` parameter (the contract address itself is the unique identifier)
- Storage key management (the contract's own storage is the channel)

The agent's payment header would reference the contract address instead of a channel_id.

### State

```rust
#[contracttype]
pub struct Channel {
    pub agent: Address,
    pub agent_pubkey: BytesN<32>,
    pub server: Address,
    pub server_pubkey: BytesN<32>,
    pub asset: Address,
    pub deposit: i128,
    pub status: ChannelStatus,          // Open | Closing | Closed
    pub force_close_ledger: Option<u32>, // set when agent calls force_close
}
```

No `iteration`, `agent_balance`, `server_balance`, or `DisputeState` in storage. The latest state lives off-chain until settlement.

### `open(agent, agent_pubkey, server, server_pubkey, asset, deposit)`

Same as v1 but without `nonce` (contract address is the unique ID).

```
- agent.require_auth()
- Transfer deposit from agent to contract
- Store Channel { status: Open, ... }
```

### `settle(state, agent_sig)` — server only

The server calls this with the latest agent-signed state. Only one signature required — the agent's. The server doesn't need to sign because:
- The server is the one calling `settle`, so `server.require_auth()` proves it's them
- The agent's signature over the state proves the agent agreed to that balance split

```
- server.require_auth()   ← Soroban auth proves caller is the server
- Verify channel is Open or Closing
- Verify state.agent_balance + state.server_balance == deposit
- Verify agent_sig over state message
- Transfer agent_balance to agent, server_balance to server
- Mark Closed
```

This is the happy path. Works whether channel is `Open` or `Closing` (server can settle even after agent initiates force-close).

### `force_close()` — agent only

The agent calls this when the server is unresponsive. No state is submitted — just starts a timer.

```
- agent.require_auth()
- Verify channel is Open
- Set force_close_ledger = current_ledger + GRACE_PERIOD
- Mark Closing
```

After `GRACE_PERIOD` ledgers (~42 min at 5s/ledger = 500 ledgers), anyone can call `reclaim()` to return the full deposit to the agent.

**Why full refund?** The agent only signed states that benefit the server. If the server can't be bothered to submit those states within the grace period, the agent shouldn't be penalized. This also means commitments only need to flow in one direction — the agent never needs the server's counter-signature for safety, only for the demo's verification UX.

### `reclaim()` — permissionless, after grace period

```
- Verify channel is Closing
- Verify current_ledger > force_close_ledger
- Transfer full deposit to agent
- Mark Closed
```

No signatures, no state — just a timeout check. Anyone can call this (the agent, a relayer, a cron job).

### Signed State Message

v1 uses a custom 72-byte message:
```
channel_id (32) || iteration (8) || agent_balance (16) || server_balance (16)
```

v2 options:

**Option A: Keep the custom message, drop channel_id**
```
iteration (8) || agent_balance (16) || server_balance (16) = 40 bytes
```
The contract address replaces channel_id as the scope. Simpler, smaller.

**Option B: Soroban detached auth (Tomer's suggestion)**
Use `require_auth_for_args()` or equivalent so the agent's signature is a standard Soroban auth entry over the settle function arguments. This means:
- No custom message format
- Standard tooling (wallets, explorers) can inspect the auth
- The SDK handles message construction

This is worth investigating but may add complexity to the off-chain signing flow, since the agent needs to produce a Soroban auth entry without submitting a transaction. Needs prototyping to evaluate ergonomics.

**Recommendation:** Start with Option A for simplicity, prototype Option B separately.

## Migration Impact

### Contract changes
- New contract crate (or major refactor of existing)
- Simpler: ~100 lines of Rust vs ~250 in v1
- No DisputeState, no resolve_dispute, no finalize_dispute
- Deploy per channel instead of once globally

### Demo changes (worker.ts)
- `openChannelOnChain` deploys a new contract instance instead of calling `open_channel` on a shared instance
- Channel ID becomes the contract address (no `deriveChannelId` / nonce / SHA-256)
- `closeChannelOnChain` calls `settle(state, agent_sig)` instead of `close_channel(id, state, agent_sig, server_sig)` — only agent sig needed
- Remove server signature verification from the close path (server doesn't need to counter-sign for settlement safety — only for the demo's proof-of-purchase UX)

### NFT service changes (channel.ts)
- Counter-signature is still useful as a receipt/proof that the server accepted the payment, but it's no longer required for on-chain settlement
- The `x-payment-response` header with server counter-sig remains as an optional proof

### Off-chain protocol
- Simpler: agent signs states, server verifies + serves content. Server counter-signing becomes optional (receipt, not settlement requirement)
- The `payment-signature` header format stays the same minus the `channelId` field (replaced by contract address in the URL or a separate field)

## Open Questions

1. **Contract deployment cost per channel** — deploying a new WASM instance per channel has a cost. Is it acceptable? Could use `deployer` pattern to reduce overhead. Alternatively, a factory contract that creates lightweight channel instances.

2. **Soroban detached auth ergonomics** — Can the agent produce a valid Soroban auth entry off-chain without a full transaction simulation? The Stellar SDK would need to support this. Worth prototyping.

3. **Grace period duration** — v1 uses 500 ledgers (~42 min). For v2, the grace period only matters if the server is offline. Could be shorter (the server is presumably a Cloudflare Worker with high uptime) or configurable per channel.

4. **Channel top-up** — v1 doesn't support adding more deposit to an open channel. v2 could add a `top_up(amount)` entry point since the scoping is simpler. Useful for long-running agent sessions.

## References

- Tomer's protocol design (thread contributions #7-#10) — primary design input
- [Tempo TempoStreamChannel.sol](https://github.com/tempoxyz/tempo/blob/main/contracts/src/TempoStreamChannel.sol) — similar design: cumulative vouchers, server-only settlement, grace period on user close
- [Starlight](https://stellar.org/blog/developers/starlight-a-layer-2-payment-channel-protocol-for-stellar) — prior Stellar payment channel work (bidirectional, more complex)
- Leigh's input: Soroban contract > G-account approach, unidirectional simplifies design
