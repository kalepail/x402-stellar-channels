# x402 Stellar Channels

A proof-of-concept unidirectional payment channel for [x402](https://www.x402.org/) on Stellar, using Soroban smart contracts. Reduces per-request payment overhead from ~5s to <10ms after channel open.

## The Problem

x402 requires an on-chain transaction per API call. For an AI agent making 100 calls to a paid API, that's over 8 minutes of payment latency — before the actual work even begins.

## The Solution

Open a channel once (1 on-chain tx), pay per request with a local ed25519 signature (no chain), close once (1 on-chain tx). N calls = 2 transactions total.

```
SETUP (once, ~7s):      Agent → Relayer → Stellar: open_channel(deposit)
EACH REQUEST (~ms):     Agent → Server: GET /resource + payment-signature: {signed state}
                        Server verifies ed25519 locally → 200 OK + counter-signature
TEARDOWN (once, ~5s):   Relayer → Stellar: close_channel(final mutual state)
```

## Live Demo

The demo is a Cloudflare Worker that races a real channel payment flow against simulated traditional x402:

- **Channel side** — Opens a real USDC channel on Stellar testnet, purchases generative art from a live NFT service with signed channel payments, closes the channel. Everything is real: real USDC, real ed25519 signatures, real Soroban contract.
- **Traditional side** — Simulates 1 on-chain tx per image at real Stellar ledger close speed (~5s each).

### Run locally

```bash
cd demo
pnpm install
pnpm setup:testnet    # one-time: creates keypairs, deploys contract, writes .env.testnet
pnpm dev              # starts wrangler dev server at localhost:8787
```

### Deploy

```bash
# Set secrets (from .env.testnet values)
wrangler secret put AGENT_SECRET
wrangler secret put FACILITATOR_SECRET
wrangler secret put CHANNEL_SERVER_PUBLIC
wrangler secret put NFT_SERVICE_PAY_TO
wrangler secret put USDC_CONTRACT_ID
wrangler secret put CHANNEL_CONTRACT_ID

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
| `open_channel` | Agent deposits USDC into escrow; 1 on-chain tx |
| `close_channel` | Both parties sign final state; immediate settlement |
| `initiate_dispute` | Either party submits their last-known state; ~42min observation window starts |
| `resolve_dispute` | Counter-party presents higher-iteration mutual state; window resets |
| `finalize_dispute` | After window expires, highest-iteration state wins |
| `keep_alive` | Extends Soroban storage TTL for long-running channels |

### Fee-Bump Relaying

The demo uses a fee-bump relayer so the agent never spends XLM on transaction fees. The agent signs the inner transaction (authorizing the contract call), and the relayer wraps it in a fee-bump transaction that covers all XLM costs.

### Backwards Compatibility

The `channel` scheme is additive — servers advertise both `exact` (vanilla x402) and `channel` in the 402 response. Clients that don't support channels fall back automatically.

## Security Notes

- Agent exposure is bounded by deposit amount
- Server holds latest counter-signed state; can close immediately since commitments are monotonically increasing
- Observation window (~42 min) protects against old-state submission attacks
- Either party can initiate dispute; counter-party can resolve with a higher-iteration state

## Project Structure

```
contract/           Soroban smart contract (Rust)
  src/
    lib.rs          Contract entry points
    channel.rs      Open, close, keep_alive, payout
    dispute.rs      Initiate, resolve, finalize dispute
    crypto.rs       State message construction + ed25519 verification
    types.rs        Channel, ChannelState, DisputeState types

demo/               Cloudflare Worker demo
  src/
    worker.ts       Hono SSE API (channel + vanilla race)
    crypto.ts       Ed25519 signing/verification (matches contract)
    facilitator/
      stellar.ts    Soroban SDK: open/close channel with fee-bump relay
    types.ts        ChannelState type
  public/
    index.html      Race visualization frontend
  scripts/
    setup-testnet.ts  One-time testnet setup
```

## References

- [x402-zero-latency design](https://github.com/stellar-experimental/ideas/tree/main/x402-zero-latency) — original concept
- [x402-stellar](https://github.com/stellar/x402-stellar) — vanilla x402 reference
- [x402 protocol](https://www.x402.org/)
- [Starlight](https://stellar.org/blog/developers/starlight-a-layer-2-payment-channel-protocol-for-stellar) — prior Stellar payment channel work
