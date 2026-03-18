/**
 * Web Demo — Real testnet x402 state channel purchases from the NFT service.
 *
 * Opens a real channel on Stellar testnet, purchases images from the
 * deployed NFT service using channel payments, and streams results
 * to the browser via SSE. Facilitator relays fees via fee-bump txs
 * so the agent never spends XLM on transaction fees.
 *
 *   pnpm web-demo
 *   open http://localhost:3000
 */

import express from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signState, verifyState, deriveChannelId, pubkeyBytes } from './crypto.js';
import { openChannelOnChain, closeChannelOnChain } from './facilitator/stellar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// ── Config (from .env.testnet) ──────────────────────────────────────────────

const NFT_SERVICE_URL = process.env.NFT_SERVICE_URL || 'https://x402-nft-service.sdf-ecosystem.workers.dev';
const PRICE = 10_000n; // $0.001 USDC per image (7 decimals)
const STELLAR_CLOSE_TIME_MS = 5_000; // Stellar ledger close time (~5-6s)
const CONCURRENCY = 100; // parallel requests to NFT service (channel is stateless)

// Keypairs from .env.testnet
const agentKeypair = Keypair.fromSecret(process.env.AGENT_SECRET!);
const facilitatorKeypair = Keypair.fromSecret(process.env.FACILITATOR_SECRET!);

// Channel server's public key (NFT service's CHANNEL_SERVER_SECRET keypair)
const channelServerPublic = process.env.CHANNEL_SERVER_PUBLIC!;

// NFT service's merchant address (receives payment on channel close)
const nftServicePayTo = process.env.NFT_SERVICE_PAY_TO!;

// Contract IDs
const usdcContractId = process.env.USDC_CONTRACT_ID || process.env.TOKEN_CONTRACT_ID!;
const channelContractId = process.env.CHANNEL_CONTRACT_ID!;

// Art style for purchased images
const STYLE = 'attractor';

// ── Static files ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../web')));

// ── Image cache ─────────────────────────────────────────────────────────────
const imageCache = new Map<string, Buffer>();

app.get('/api/images/:runId/:index', (req, res) => {
  const key = `${req.params.runId}/${req.params.index}`;
  const img = imageCache.get(key);
  if (!img) return res.status(404).end();
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
  res.send(img);
});

// ── SSE helpers ─────────────────────────────────────────────────────────────
function sseHeaders(res: express.Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
}

function sendEvent(res: express.Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Channel run (REAL testnet purchases) ────────────────────────────────────

// Mutex: only one channel run at a time (agent keypair has one sequence number)
let activeChannelRun: AbortController | null = null;

app.get('/api/run/channel', async (req, res) => {
  // Abort any previous run
  if (activeChannelRun) {
    activeChannelRun.abort();
  }
  const abort = new AbortController();
  activeChannelRun = abort;

  const count = Math.min(parseInt(req.query.count as string) || 100, 5000);
  const deposit = PRICE * BigInt(count + 10); // small buffer
  const runId = Date.now().toString(36);

  sseHeaders(res);

  // Bail helper — checks if this run was superseded or client disconnected
  const cancelled = () => res.closed || abort.signal.aborted;

  try {
    // Phase 1 — Open channel on testnet
    sendEvent(res, {
      type: 'status',
      phase: 'opening',
      message: 'Opening payment channel on Stellar testnet (1 on-chain tx, relayer pays fees)…',
    });

    if (cancelled()) return;

    const openStart = performance.now();
    const nonce = randomBytes(32);
    const agentPkBytes = pubkeyBytes(agentKeypair.publicKey());
    const channelIdBuf = deriveChannelId(agentPkBytes, nonce);
    const channelId = channelIdBuf.toString('hex');

    const openTxHash = await openChannelOnChain(
      facilitatorKeypair,
      agentKeypair,
      nftServicePayTo,
      channelServerPublic, // signing key (different from payTo for NFT service)
      usdcContractId,
      channelContractId,
      deposit,
      nonce,
    );

    if (cancelled()) return;

    const openMs = Math.round(performance.now() - openStart);
    sendEvent(res, {
      type: 'status',
      phase: 'opened',
      openMs,
      txHash: openTxHash,
      message: `Channel opened in ${(openMs / 1000).toFixed(1)}s (tx: ${openTxHash.slice(0, 12)}…)`,
    });

    // Phase 2 — Pre-sign all payment states
    sendEvent(res, {
      type: 'status',
      phase: 'signing',
      message: `Pre-signing ${count} payment states…`,
    });

    const signStart = performance.now();
    const signed: Array<{
      iteration: bigint;
      agentBalance: bigint;
      serverBalance: bigint;
      sig: Buffer;
    }> = [];

    for (let i = 1; i <= count; i++) {
      const iteration = BigInt(i);
      const serverBalance = iteration * PRICE;
      const agentBalance = deposit - serverBalance;
      const sig = signState(agentKeypair, channelIdBuf, iteration, agentBalance, serverBalance);
      signed.push({ iteration, agentBalance, serverBalance, sig });
    }

    const signMs = Math.round(performance.now() - signStart);
    sendEvent(res, {
      type: 'status',
      phase: 'signed',
      signMs,
      message: `Pre-signed ${count} states in ${signMs}ms`,
    });

    if (cancelled()) return;

    // Phase 3 — Purchase images from NFT service with channel payments
    sendEvent(res, {
      type: 'status',
      phase: 'purchasing',
      message: `Purchasing ${count} images from NFT service (${CONCURRENCY} concurrent)…`,
    });

    const purchaseStart = performance.now();
    let completed = 0;

    // Track server counter-signatures by iteration for correct close
    const serverSigs = new Map<number, Buffer>();

    // Process in batches for controlled concurrency
    for (let batchStart = 0; batchStart < count; batchStart += CONCURRENCY) {
      if (cancelled()) break;

      const batchEnd = Math.min(batchStart + CONCURRENCY, count);
      const batch = signed.slice(batchStart, batchEnd);

      const results = await Promise.allSettled(
        batch.map(async (st, batchIdx) => {
          const idx = batchStart + batchIdx;
          const seed = Date.now() + idx;

          // Build channel payment header (stateless — includes deposit + agentPublicKey)
          const header = JSON.stringify({
            scheme: 'channel',
            channelId,
            iteration: String(st.iteration),
            agentBalance: String(st.agentBalance),
            serverBalance: String(st.serverBalance),
            deposit: String(deposit),
            agentPublicKey: agentKeypair.publicKey(),
            agentSig: st.sig.toString('hex'),
          });

          const resp = await fetch(`${NFT_SERVICE_URL}/mint/${STYLE}?seed=${seed}`, {
            headers: { 'payment-signature': header },
            signal: abort.signal,
          });

          if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
          }

          // Store the PNG
          const png = Buffer.from(await resp.arrayBuffer());
          imageCache.set(`${runId}/${idx}`, png);

          // Verify server counter-signature and store it keyed by iteration
          const respHeader = resp.headers.get('x-payment-response');
          if (respHeader) {
            const parsed = JSON.parse(respHeader);
            const serverSig = Buffer.from(parsed.serverSig, 'hex');
            verifyState(
              channelServerPublic,
              serverSig,
              channelIdBuf,
              st.iteration,
              st.agentBalance,
              st.serverBalance,
            );
            serverSigs.set(idx, serverSig);
          }

          return { idx, pngSize: png.length };
        }),
      );

      if (cancelled()) break;

      // Stream results for this batch
      for (const result of results) {
        if (result.status === 'fulfilled') {
          completed++;
          const elapsed = Math.round(performance.now() - purchaseStart);
          sendEvent(res, {
            type: 'image',
            index: result.value.idx,
            runId,
            pngSize: result.value.pngSize,
            elapsed,
            iteration: completed,
          });
        } else if (!abort.signal.aborted) {
          sendEvent(res, { type: 'error', message: result.reason?.message || 'Unknown error' });
        }
      }
    }

    if (cancelled()) return;

    const purchaseMs = Math.round(performance.now() - purchaseStart);

    // Phase 4 — Close channel on testnet using highest-iteration mutual state
    sendEvent(res, {
      type: 'status',
      phase: 'closing',
      message: 'Closing payment channel on Stellar testnet (1 on-chain tx, relayer pays fees)…',
    });

    const closeStart = performance.now();
    let closeTxHash = '';

    // Find the highest iteration that has a server counter-signature
    const highestIdx = [...serverSigs.keys()].sort((a, b) => b - a)[0];

    if (highestIdx !== undefined && completed > 0) {
      const finalState = signed[highestIdx];
      const finalServerSig = serverSigs.get(highestIdx)!;
      const agentSig = finalState.sig; // Use the pre-signed agent signature

      closeTxHash = await closeChannelOnChain(
        facilitatorKeypair,
        agentKeypair,
        channelContractId,
        {
          channelId,
          iteration: finalState.iteration,
          agentBalance: finalState.agentBalance,
          serverBalance: finalState.serverBalance,
        },
        agentSig,
        finalServerSig,
      );
    }

    if (cancelled()) return;

    const closeMs = Math.round(performance.now() - closeStart);
    const totalMs = openMs + signMs + purchaseMs + closeMs;

    sendEvent(res, {
      type: 'done',
      totalMs,
      openMs,
      signMs,
      purchaseMs,
      closeMs,
      count: completed,
      rate: purchaseMs > 0 ? (completed / (purchaseMs / 1000)).toFixed(1) : '0',
      onChainTxs: 2,
      openTxHash,
      closeTxHash,
    });
  } catch (err) {
    if (!cancelled()) {
      sendEvent(res, { type: 'error', message: String(err) });
    }
  } finally {
    if (activeChannelRun === abort) {
      activeChannelRun = null;
    }
    res.end();
  }
});

// ── Vanilla (simulated at real Stellar speed) ───────────────────────────────
app.get('/api/run/vanilla', async (req, res) => {
  const count = Math.min(parseInt(req.query.count as string) || 100, 5000);

  sseHeaders(res);

  sendEvent(res, {
    type: 'status',
    phase: 'purchasing',
    message: `Traditional x402 — 1 on-chain tx per image (~${STELLAR_CLOSE_TIME_MS / 1000}s each, real Stellar ledger close time)…`,
  });

  const startTime = performance.now();

  for (let i = 0; i < count; i++) {
    if (res.closed) break;

    // Wait the real Stellar ledger close time per image
    await sleep(STELLAR_CLOSE_TIME_MS);

    const svg = generatePlaceholder(i);
    const elapsed = Math.round(performance.now() - startTime);

    sendEvent(res, {
      type: 'image',
      index: i,
      svg,
      elapsed,
      iteration: i + 1,
    });
  }

  if (!res.closed) {
    const totalMs = Math.round(performance.now() - startTime);
    sendEvent(res, {
      type: 'done',
      totalMs,
      count,
      rate: (1000 / STELLAR_CLOSE_TIME_MS).toFixed(2),
      onChainTxs: count,
    });
    res.end();
  }
});

// ── Placeholder SVG for vanilla side ────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generatePlaceholder(seed: number): string {
  const rng = mulberry32(seed * 2654435761 + 1);
  const hue1 = Math.floor(rng() * 360);
  const hue2 = (hue1 + 40 + Math.floor(rng() * 80)) % 360;
  const bgL = 4 + Math.floor(rng() * 6);
  const bg = `hsl(${hue1},25%,${bgL}%)`;

  let shapes = '';
  const n = 6 + Math.floor(rng() * 6);
  for (let i = 0; i < n; i++) {
    const cx = rng() * 100;
    const cy = rng() * 100;
    const r = 6 + rng() * 28;
    const h = rng() < 0.5 ? hue1 : hue2;
    const s = 55 + Math.floor(rng() * 35);
    const l = 40 + Math.floor(rng() * 30);
    const a = (0.12 + rng() * 0.4).toFixed(2);
    shapes += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="hsl(${h},${s}%,${l}%)" opacity="${a}"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${bg}"/>${shapes}</svg>`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.WEB_DEMO_PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`\n  x402 State Channel Demo (LIVE TESTNET)`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`\n  Agent:       ${agentKeypair.publicKey()}`);
  console.log(`  Facilitator: ${facilitatorKeypair.publicKey()}`);
  console.log(`  NFT Service: ${NFT_SERVICE_URL}`);
  console.log(`  Channel Contract: ${channelContractId}\n`);
});
