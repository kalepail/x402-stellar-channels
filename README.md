# x402 Stellar Channels

A proof-of-concept unidirectional payment channel for [x402](https://www.x402.org/) on Stellar, using Soroban smart contracts. Reduces per-request payment overhead from ~5s (on-chain transaction) to <10ms (off-chain signature) after channel open.

## The Problem

x402 requires an on-chain transaction per API call. For an AI agent making 100 calls to a paid API, that's over 8 minutes of cumulative payment latency — before the actual work even begins.

## The Solution

Open a channel once (1 on-chain tx), pay per request with a local ed25519 signature (no chain), close once (1 on-chain tx). **N calls = 2 transactions total.**

```
SETUP (once, ~7s):      Agent → Relayer → Stellar: open_channel(deposit)
EACH REQUEST (~ms):     Agent → Server: GET /resource + payment-signature: {signed state}
                        Server verifies ed25519 locally → 200 OK + counter-signature
TEARDOWN (once, ~5s):   Relayer → Stellar: close_channel(final mutual state)
```

## Live Demo

The demo is a Cloudflare Worker that races a real channel payment flow against simulated traditional x402:

- **Channel side** — Opens a real USDC channel on Stellar testnet, purchases generative art from a live [NFT service](https://x402-nft-service.sdf-ecosystem.workers.dev/) with signed channel payments, and closes the channel. Everything is real: real USDC, real ed25519 signatures, real Soroban contract calls.
- **Traditional side** — Simulates 1 on-chain tx per image at real Stellar ledger close speed (~5s each). Uses placeholder art and local timing — honest on speed, simulated on workload.

### Run locally

```bash
cd demo
pnpm install
pnpm setup:testnet    # one-time: creates keypairs, funds accounts, deploys contract
pnpm dev              # starts wrangler dev server at localhost:8787
```

### Deploy

```bash
cd demo

# Set secrets (values come from .env.testnet)
wrangler secret put AGENT_SECRET
wrangler secret put FACILITATOR_SECRET

# Public config lives in demo/wrangler.jsonc vars:
# CHANNEL_SERVER_PUBLIC
# NFT_SERVICE_PAY_TO
# NFT_SERVICE_URL
# USDC_CONTRACT_ID
# CHANNEL_CONTRACT_ID
# NETWORK
# RPC_URL

pnpm deploy
```

## How It Works

### Off-chain State

Each API request includes a signed 72-byte state in the `payment-signature` header:

```json
{
  "scheme": "channel",
  "channelId": "abc...",
  "iteration": "42",
  "agentBalance": "9580000",
  "serverBalance": "420000",
  "deposit": "10000000",
  "agentPublicKey": "G...",
  "agentSig": "a3f1..."
}
```

The server verifies the ed25519 signature locally (microseconds, no network) and responds with its counter-signature. The highest mutually-signed state can be submitted on-chain at any time.

### Soroban Contract

The contract manages channel lifecycle and dispute resolution:

| Function | Description |
|---|---|
| `open_channel` | Agent deposits USDC into escrow; derives `channel_id` from `sha256(agent_pubkey \|\| nonce)` |
| `close_channel` | Both parties sign final state; immediate settlement — distributes funds |
| `initiate_dispute` | Either party submits their last-known signed state; starts ~42min observation window |
| `resolve_dispute` | Counter-party presents a higher-iteration mutual state during the window; resets timer |
| `finalize_dispute` | After window expires, settles using the stored dispute state (permissionless) |
| `keep_alive` | Extends Soroban storage TTL for long-running channels |

### Signed State Message

The off-chain state is a canonical 72-byte big-endian message:

```
channel_id (32) || iteration (8) || agent_balance (16) || server_balance (16)
```

Both the Rust contract (`crypto.rs`) and the TypeScript client (`crypto.ts`) build this identically, enabling cross-language signature verification.

### Fee-Bump Relaying

The demo uses a fee-bump relayer so the agent never spends XLM on transaction fees. The agent signs the inner transaction (authorizing the contract call), and the relayer wraps it in a fee-bump transaction that covers all XLM costs.

### Backwards Compatibility

The `channel` scheme is additive — servers advertise both `exact` (vanilla x402) and `channel` in the 402 response. Clients that don't support channels fall back automatically.

## Security Properties

- **Bounded exposure** — Agent risk is limited to the deposit amount
- **Monotonic commitments** — Server holds the latest counter-signed state; can close immediately since server_balance only increases
- **Replay protection** — Contract enforces `iteration > stored_iteration`; once a higher iteration is on-chain, all lower ones are permanently invalid
- **Observation window** — ~42 min (500 ledgers) protects against old-state submission; resets on each valid dispute resolution
- **Permissionless finalization** — Anyone can call `finalize_dispute` after the window expires (enables relayers, cron jobs)

## Relationship to x402-nft-service

This repo provides the **channel infrastructure** — the Soroban contract, cryptographic primitives, on-chain operations, and a visual demo that ties everything together.

The [x402-nft-service](https://x402-nft-service.sdf-ecosystem.workers.dev/) is a separate Cloudflare Worker that acts as the **paid API server**. It accepts both `exact` (vanilla x402) and `channel` payment schemes, generates deterministic generative art, and handles payment verification. The demo in this repo purchases images from the live NFT service using real channel payments.

```
x402-stellar-channels (this repo)        x402-nft-service (separate)
├── contract/  ← Soroban channel logic   ├── x402 middleware (exact + channel)
├── demo/      ← visual race demo        ├── channel signature verification
│   ├── crypto.ts  ← sign/verify         ├── generative art (4 algorithms)
│   ├── stellar.ts ← open/close on-chain └── SVG→PNG rendering
│   └── worker.ts  ← SSE orchestration
```

## Project Structure

```
contract/           Soroban smart contract (Rust)
  src/
    lib.rs          Contract entry points (6 public functions)
    channel.rs      Open, close, keep_alive, payout
    dispute.rs      Initiate, resolve, finalize dispute
    crypto.rs       72-byte state message construction + ed25519 verification
    types.rs        Channel, ChannelState, DisputeState, constants
  tests/
    channel_lifecycle.rs   Open/close happy path + edge cases
    dispute_flow.rs        Full dispute lifecycle + edge cases

demo/               Cloudflare Worker demo (TypeScript)
  src/
    worker.ts       Hono SSE API (channel + vanilla race endpoints)
    crypto.ts       Ed25519 signing/verification (matches contract)
    types.ts        ChannelState type
    facilitator/
      stellar.ts    Soroban SDK rpc.Server + fee-bump relay
  public/
    index.html      Race visualization frontend
  test/
    crypto.spec.ts        Crypto round-trip + edge cases
    worker-smoke.spec.ts  Route + SSE smoke tests
  scripts/
    setup-testnet.ts      One-time testnet setup (keypairs, funding, deploy)
```

## Development

```bash
# Run all checks (mirrors CI)
make check

# Individual targets
make test-contract     # cargo test --features testutils
make test-demo         # pnpm test
make lint              # clippy + eslint
make fmt               # cargo fmt + prettier
make typecheck         # tsc --noEmit
```

## References

- [x402-zero-latency design](https://github.com/stellar-experimental/ideas/tree/main/x402-zero-latency) — original concept
- [x402-stellar](https://github.com/stellar/x402-stellar) — vanilla x402 reference
- [x402 protocol](https://www.x402.org/)
- [Starlight](https://stellar.org/blog/developers/starlight-a-layer-2-payment-channel-protocol-for-stellar) — prior Stellar payment channel work
