/**
 * Cloudflare Worker — x402 State Channel Demo
 *
 * Uses Hono's streamSSE helper for CF-native Server-Sent Events.
 * Opens a real channel on Stellar testnet, purchases images from the
 * deployed NFT service using channel payments, and streams results
 * to the browser via SSE.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { Keypair } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { signState, verifyState, deriveChannelId, pubkeyBytes } from './crypto.js';
import {
  openChannelOnChain,
  closeChannelOnChain,
  configureStellar,
} from './facilitator/stellar.js';

const app = new Hono<{ Bindings: CloudflareBindings }>();

// ── Config ────────────────────────────────────────────────────────────────────
const PRICE = 10_000n; // $0.001 USDC per image (7 decimals)
const STELLAR_CLOSE_TIME_MS = 5_000;
// CF Workers allow max 6 simultaneous outbound connections per request.
// Using 6 keeps us at the limit without queueing stalls.
const CONCURRENCY = 6;
const STYLE = 'attractor';

// ── Image cache (in-memory, bounded, resets on redeploy) ─────────────────────
const svgCache = new Map<string, string>();
const SVG_CACHE_MAX = 1000;

function cacheSet(key: string, value: string) {
  if (svgCache.size >= SVG_CACHE_MAX) svgCache.delete(svgCache.keys().next().value!);
  svgCache.set(key, value);
}

app.get('/api/images/:runId/:index', (c) => {
  const key = `${c.req.param('runId')}/${c.req.param('index')}`;
  const svg = svgCache.get(key);
  if (!svg) return c.notFound();
  return c.body(svg, 200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'public, max-age=3600',
  });
});

// ── Channel run (REAL testnet purchases) ─────────────────────────────────────
app.get('/api/run/channel', (c) => {
  const env = c.env;
  configureStellar(
    env.RPC_URL || 'https://soroban-rpc.testnet.stellar.gateway.fm',
    env.NETWORK || 'testnet',
  );
  const nftServiceUrl = env.NFT_SERVICE_URL || 'https://x402-nft-service.sdf-ecosystem.workers.dev';
  const agentKeypair = Keypair.fromSecret(env.AGENT_SECRET);
  const facilitatorKeypair = Keypair.fromSecret(env.FACILITATOR_SECRET);
  const channelServerPublic = env.CHANNEL_SERVER_PUBLIC;
  const nftServicePayTo = env.NFT_SERVICE_PAY_TO;
  const usdcContractId = env.USDC_CONTRACT_ID || env.TOKEN_CONTRACT_ID;
  const channelContractId = env.CHANNEL_CONTRACT_ID;

  const count = Math.min(parseInt(c.req.query('count') || '100'), 500);
  const deposit = PRICE * BigInt(count + 10);
  const runId = Date.now().toString(36);

  return streamSSE(c, async (stream) => {
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
    });

    const send = (data: Record<string, unknown>) => stream.writeSSE({ data: JSON.stringify(data) });

    try {
      // Phase 1 — Open channel
      await send({
        type: 'status',
        phase: 'opening',
        message: 'Opening payment channel on Stellar testnet (1 on-chain tx, relayer pays fees)…',
      });

      if (aborted) return;

      const openStart = performance.now();
      const nonce = randomBytes(32);
      const agentPkBytes = pubkeyBytes(agentKeypair.publicKey());
      const channelIdBuf = deriveChannelId(agentPkBytes, nonce);
      const channelId = channelIdBuf.toString('hex');

      const openTxHash = await retry(() =>
        openChannelOnChain(
          facilitatorKeypair,
          agentKeypair,
          nftServicePayTo,
          channelServerPublic,
          usdcContractId,
          channelContractId,
          deposit,
          nonce,
        ),
      );

      if (aborted) return;

      const openMs = Math.round(performance.now() - openStart);
      await send({
        type: 'status',
        phase: 'opened',
        openMs,
        txHash: openTxHash,
        message: `Channel opened in ${(openMs / 1000).toFixed(1)}s (tx: ${openTxHash.slice(0, 12)}…)`,
      });

      // Phase 2 — Pre-sign all payment states
      await send({
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
      await send({
        type: 'status',
        phase: 'signed',
        signMs,
        message: `Pre-signed ${count} states in ${signMs}ms`,
      });

      if (aborted) return;

      // Phase 3 — Purchase images from NFT service
      await send({
        type: 'status',
        phase: 'purchasing',
        message: `Purchasing ${count} images from NFT service (${CONCURRENCY} concurrent)…`,
      });

      const purchaseStart = performance.now();
      let completed = 0;
      let skipped = 0;
      const serverSigs = new Map<number, Buffer>();

      for (let batchStart = 0; batchStart < count && !aborted; batchStart += CONCURRENCY) {
        const batchEnd = Math.min(batchStart + CONCURRENCY, count);
        const batch = signed.slice(batchStart, batchEnd);

        const results = await Promise.allSettled(
          batch.map(async (st, batchIdx) => {
            const idx = batchStart + batchIdx;
            const seed = Date.now() + idx;

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

            const resp = await retry(async () => {
              const r = await fetch(
                `${nftServiceUrl}/mint/${STYLE}?seed=${seed}&format=svg&size=100`,
                {
                  headers: { 'payment-signature': header, Accept: 'image/svg+xml' },
                },
              );
              if (!r.ok) {
                const body = await r.text();
                throw new Error(`HTTP ${r.status}: ${body.slice(0, 500)}`);
              }
              return r;
            });

            const svg = await resp.text();
            cacheSet(`${runId}/${idx}`, svg);

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

            return { idx, size: svg.length };
          }),
        );

        if (aborted) break;

        for (const result of results) {
          if (result.status === 'fulfilled') {
            completed++;
            const elapsed = Math.round(performance.now() - purchaseStart);
            await send({
              type: 'image',
              index: result.value.idx,
              runId,
              size: result.value.size,
              elapsed,
              iteration: completed,
            });
          } else {
            skipped++;
            await send({
              type: 'skip',
              message: result.reason?.message || 'Unknown error',
              completed,
              skipped,
            });
          }
        }
      }

      if (aborted) return;

      const purchaseMs = Math.round(performance.now() - purchaseStart);

      // Phase 4 — Close channel
      await send({
        type: 'status',
        phase: 'closing',
        message: 'Closing payment channel on Stellar testnet (1 on-chain tx, relayer pays fees)…',
      });

      const closeStart = performance.now();
      let closeTxHash = '';

      const highestIdx = [...serverSigs.keys()].sort((a, b) => b - a)[0];

      if (highestIdx !== undefined && completed > 0) {
        const finalState = signed[highestIdx];
        const finalServerSig = serverSigs.get(highestIdx)!;
        const agentSig = finalState.sig;

        closeTxHash = await retry(() =>
          closeChannelOnChain(
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
          ),
        );
      }

      if (aborted) return;

      const closeMs = Math.round(performance.now() - closeStart);
      const totalMs = openMs + signMs + purchaseMs + closeMs;

      await send({
        type: 'done',
        totalMs,
        openMs,
        signMs,
        purchaseMs,
        closeMs,
        count: completed,
        skipped,
        rate: purchaseMs > 0 ? (completed / (purchaseMs / 1000)).toFixed(1) : '0',
        onChainTxs: 2,
        openTxHash,
        closeTxHash,
      });
    } catch (err) {
      if (!aborted) {
        await send({ type: 'error', message: String(err), fatal: isFatal(err) });
      }
    }
  });
});

// ── Vanilla (simulated at real Stellar speed) ────────────────────────────────
app.get('/api/run/vanilla', (c) => {
  const count = Math.min(parseInt(c.req.query('count') || '100'), 500);

  return streamSSE(c, async (stream) => {
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
    });

    const send = (data: Record<string, unknown>) => stream.writeSSE({ data: JSON.stringify(data) });

    await send({
      type: 'status',
      phase: 'purchasing',
      message: `Traditional x402 — 1 on-chain tx per image (~${STELLAR_CLOSE_TIME_MS / 1000}s each, real Stellar ledger close time)…`,
    });

    const startTime = performance.now();

    for (let i = 0; i < count && !aborted; i++) {
      await stream.sleep(STELLAR_CLOSE_TIME_MS);
      if (aborted) break;

      const svg = generatePlaceholder(i);
      const elapsed = Math.round(performance.now() - startTime);

      await send({
        type: 'image',
        index: i,
        svg,
        elapsed,
        iteration: i + 1,
      });
    }

    if (!aborted) {
      const totalMs = Math.round(performance.now() - startTime);
      await send({
        type: 'done',
        totalMs,
        count,
        rate: (1000 / STELLAR_CLOSE_TIME_MS).toFixed(2),
        onChainTxs: count,
      });
    }
  });
});

// ── Placeholder SVG for vanilla side ─────────────────────────────────────────
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

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Errors matching these patterns are not transient — retrying won't help. */
const FATAL_PATTERNS = ['Account not found', 'Keypair', 'invalid secret'];

function isFatal(err: unknown): boolean {
  const msg = String(err);
  return FATAL_PATTERNS.some((p) => msg.includes(p));
}

async function retry<T>(fn: () => Promise<T>, maxAttempts = 3, delayMs = 1000): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isFatal(err) || attempt === maxAttempts) throw err;
      await sleep(delayMs * attempt);
    }
  }
  throw new Error('unreachable');
}

export default app;
