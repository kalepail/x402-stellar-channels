# x402 Stellar Channels

A proof-of-concept unidirectional payment channel for [x402](https://www.x402.org/) on Stellar, using Soroban smart contracts. Reduces per-request payment overhead from ~5s to <10ms after channel open.

---

## The Problem

x402 requires an on-chain transaction per API call. For an AI agent making 20 calls to a paid API, that's ~100 seconds of payment latency — before the actual work even begins.

## The Solution

Open a channel once (1 on-chain tx), pay per request with a local ed25519 signature (no chain), close once (1 on-chain tx). N calls = 2 transactions total.

```
SETUP (once, ~7s):      Agent → Facilitator → Stellar: open_channel(deposit=1 USDC)
EACH REQUEST (~10ms):   Agent → Server: GET /data + X-Payment: {signed state}
                        Server verifies signature locally → 200 OK
TEARDOWN (once, ~5s):   Agent → Facilitator → Stellar: close_channel(finalState)
```

## Benchmark

| Mode | 20 calls total | Per-call avg |
|------|----------------|--------------|
| Vanilla x402 | ~102s | ~5,100ms |
| Channel x402 | ~12s (incl. open+close) | ~10ms |
| **Speedup** | **8.8x** | **509x** |

Break-even: **3 calls** (channels win from the 3rd call onward).

---

## Prerequisites

- [Rust](https://rustup.rs/) + `wasm32-unknown-unknown` target:
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/install):
  ```bash
  cargo install stellar-cli --features opt
  ```
- Node.js 22+ and [pnpm](https://pnpm.io/installation)

## Quick Start

```bash
# Install TypeScript deps and deploy to testnet (creates .env.testnet)
cd demo
pnpm install
pnpm setup:testnet

# Terminal 1: facilitator
pnpm facilitator

# Terminal 2: API server
pnpm api

# Terminal 3: benchmark
pnpm benchmark
```

## How It Works

### Off-chain State

Each API request includes a signed 72-byte state in the `X-Payment` header:

```json
{
  "scheme": "channel",
  "channelId": "abc...",
  "iteration": 42,
  "agentBalance": "9580000",
  "serverBalance": "420000",
  "agentSig": "a3f1..."
}
```

The server verifies the ed25519 signature locally (microseconds, no network) and responds with its counter-signature. Both parties accumulate the latest mutual state, which can be submitted on-chain at any time.

### Soroban Contract

The contract manages channel lifecycle and dispute resolution:

| Function | Description |
|---|---|
| `open_channel` | Agent deposits USDC into escrow; 1 on-chain tx |
| `close_channel` | Both parties sign final state; immediate settlement |
| `initiate_dispute` | Either party submits their last-known state; 42min window starts |
| `resolve_dispute` | Counter-party presents higher-iteration mutual state; window resets |
| `finalize_dispute` | After window expires, highest-iteration state wins |
| `keep_alive` | Extends Soroban storage TTL for long-running channels |

### Backwards Compatibility

The `channel` scheme is additive — servers advertise both `exact` (vanilla x402) and `channel` in the 402 response. Clients that don't support channels fall back automatically.

## Security Notes

- Agent exposure is bounded by deposit amount
- Server holds latest counter-signed state; can initiate dispute if agent vanishes
- Observation window (~42 min) protects against old-state submission attacks
- On-chain settlement reveals total payment flow (not privacy-preserving)

## References

- [x402-zero-latency design](https://github.com/stellar-experimental/ideas/tree/main/x402-zero-latency) — original concept
- [x402-stellar](https://github.com/stellar/x402-stellar) — vanilla x402 reference
- [x402 protocol](https://www.x402.org/)
- [Starlight](https://stellar.org/blog/developers/starlight-a-layer-2-payment-channel-protocol-for-stellar) — prior Stellar payment channel work
