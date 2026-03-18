/**
 * Tests for the web demo SSE endpoints — verifies that the race/re-race
 * flow works correctly, connections are cleaned up, and concurrent runs
 * don't interfere with each other.
 *
 * These tests use a lightweight version of the server that skips real
 * on-chain transactions (open/close) but exercises the full SSE lifecycle.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { signState, verifyState, deriveChannelId, pubkeyBytes } from '../src/crypto.js';
import type { Server } from 'node:http';

// ── Test server (mimics web-demo.ts without real on-chain ops) ──────────────

const PRICE = 1_000_000n;

function createTestServer() {
  const app = express();

  const agentKeypair = Keypair.random();
  const serverKeypair = Keypair.random();

  let activeRun: AbortController | null = null;

  function sseHeaders(res: express.Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
  }

  function sendEvent(res: express.Response, data: unknown): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  app.get('/api/run/channel', async (req, res) => {
    if (activeRun) activeRun.abort();
    const abort = new AbortController();
    activeRun = abort;

    const count = Math.min(parseInt(req.query.count as string) || 5, 100);
    const deposit = PRICE * BigInt(count + 10);
    const runId = Date.now().toString(36);

    sseHeaders(res);

    const cancelled = () => res.closed || abort.signal.aborted;

    try {
      sendEvent(res, { type: 'status', phase: 'opening', message: 'Opening…' });

      if (cancelled()) return;

      // Simulate open (no real on-chain)
      await sleep(10);
      if (cancelled()) return;

      const nonce = randomBytes(32);
      const agentPkBytes = pubkeyBytes(agentKeypair.publicKey());
      const channelIdBuf = deriveChannelId(agentPkBytes, nonce);

      sendEvent(res, {
        type: 'status',
        phase: 'opened',
        openMs: 10,
        txHash: 'deadbeef00000000',
        message: 'Channel opened',
      });

      // Pre-sign
      const signed: Array<{ iteration: bigint; agentBalance: bigint; serverBalance: bigint; sig: Buffer }> = [];
      for (let i = 1; i <= count; i++) {
        const iteration = BigInt(i);
        const serverBalance = iteration * PRICE;
        const agentBalance = deposit - serverBalance;
        const sig = signState(agentKeypair, channelIdBuf, iteration, agentBalance, serverBalance);
        signed.push({ iteration, agentBalance, serverBalance, sig });
      }

      sendEvent(res, { type: 'status', phase: 'signed', signMs: 1, message: 'Signed' });

      if (cancelled()) return;

      sendEvent(res, { type: 'status', phase: 'purchasing', message: 'Purchasing…' });

      // Process payments (real crypto, simulated images)
      const purchaseStart = performance.now();
      for (let i = 0; i < count; i++) {
        if (cancelled()) break;

        const st = signed[i];
        // Server-side verify + counter-sign (real ed25519)
        verifyState(agentKeypair.publicKey(), st.sig, channelIdBuf, st.iteration, st.agentBalance, st.serverBalance);
        signState(serverKeypair, channelIdBuf, st.iteration, st.agentBalance, st.serverBalance);

        const elapsed = Math.round(performance.now() - purchaseStart);
        sendEvent(res, { type: 'image', index: i, runId, elapsed, iteration: i + 1 });
      }

      if (cancelled()) return;

      const purchaseMs = Math.round(performance.now() - purchaseStart);

      // Simulate close
      await sleep(10);
      if (cancelled()) return;

      sendEvent(res, {
        type: 'done',
        totalMs: 20 + purchaseMs,
        openMs: 10,
        signMs: 1,
        purchaseMs,
        closeMs: 10,
        count,
        rate: (count / (purchaseMs / 1000 || 0.001)).toFixed(1),
        onChainTxs: 2,
        openTxHash: 'deadbeef00000000',
        closeTxHash: 'cafebabe00000000',
      });
    } catch (err) {
      if (!cancelled()) {
        sendEvent(res, { type: 'error', message: String(err) });
      }
    } finally {
      if (activeRun === abort) activeRun = null;
      res.end();
    }
  });

  app.get('/api/run/vanilla', async (req, res) => {
    const count = Math.min(parseInt(req.query.count as string) || 5, 100);

    sseHeaders(res);
    sendEvent(res, { type: 'status', phase: 'purchasing', message: 'Traditional…' });

    for (let i = 0; i < count; i++) {
      if (res.closed) break;
      await sleep(50); // fast for tests
      sendEvent(res, { type: 'image', index: i, svg: '<svg/>', elapsed: (i + 1) * 50, iteration: i + 1 });
    }

    if (!res.closed) {
      sendEvent(res, { type: 'done', totalMs: count * 50, count, rate: '20', onChainTxs: count });
      res.end();
    }
  });

  return app;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Collect SSE events from a URL until 'done' or 'error' or timeout. */
async function collectSSE(
  url: string,
  opts: { timeoutMs?: number; abortAfterMs?: number } = {},
): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const { timeoutMs = 10_000, abortAfterMs } = opts;
  const events: Array<{ type: string; [k: string]: unknown }> = [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (abortAfterMs) {
    setTimeout(() => controller.abort(), abortAfterMs);
  }

  try {
    const resp = await fetch(url, { signal: controller.signal });
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const event = JSON.parse(line.slice(6));
          events.push(event);
          if (event.type === 'done' || event.type === 'error') {
            controller.abort();
            clearTimeout(timeout);
            return events;
          }
        }
      }
    }
  } catch {
    // AbortError is expected
  }

  clearTimeout(timeout);
  return events;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Web demo SSE', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createTestServer();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' ? addr!.port : addr;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server.close();
  });

  it('channel run completes with all expected phases', async () => {
    const events = await collectSSE(`${baseUrl}/api/run/channel?count=3`);

    const phases = events.filter((e) => e.type === 'status').map((e) => e.phase);
    expect(phases).toEqual(['opening', 'opened', 'signed', 'purchasing']);

    const images = events.filter((e) => e.type === 'image');
    expect(images).toHaveLength(3);

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done!.count).toBe(3);
    expect(done!.onChainTxs).toBe(2);
    expect(done!.openTxHash).toBeTruthy();
    expect(done!.closeTxHash).toBeTruthy();
  });

  it('each image has sequential iteration and runId', async () => {
    const events = await collectSSE(`${baseUrl}/api/run/channel?count=5`);
    const images = events.filter((e) => e.type === 'image');

    expect(images).toHaveLength(5);

    const runId = images[0].runId;
    expect(runId).toBeTruthy();
    for (const img of images) {
      expect(img.runId).toBe(runId); // all same run
    }

    const iterations = images.map((e) => e.iteration);
    expect(iterations).toEqual([1, 2, 3, 4, 5]);
  });

  it('vanilla run completes with images', async () => {
    const events = await collectSSE(`${baseUrl}/api/run/vanilla?count=3`);

    const images = events.filter((e) => e.type === 'image');
    expect(images).toHaveLength(3);

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done!.count).toBe(3);
    expect(done!.onChainTxs).toBe(3); // 1 per image
  });

  it('second channel run succeeds after first completes', async () => {
    // First run
    const events1 = await collectSSE(`${baseUrl}/api/run/channel?count=2`);
    expect(events1.find((e) => e.type === 'done')).toBeDefined();

    // Second run immediately after
    const events2 = await collectSSE(`${baseUrl}/api/run/channel?count=2`);
    expect(events2.find((e) => e.type === 'done')).toBeDefined();

    const done2 = events2.find((e) => e.type === 'done')!;
    expect(done2.count).toBe(2);

    // Should have different runIds
    const runId1 = events1.find((e) => e.type === 'image')!.runId;
    const runId2 = events2.find((e) => e.type === 'image')!.runId;
    expect(runId1).not.toBe(runId2);
  });

  it('concurrent channel runs: second aborts first', async () => {
    // Start a longer run
    const promise1 = collectSSE(`${baseUrl}/api/run/channel?count=50`, { timeoutMs: 5000 });

    // Wait a tiny bit then start a second run
    await sleep(30);
    const events2 = await collectSSE(`${baseUrl}/api/run/channel?count=2`);

    const events1 = await promise1;

    // Second run should complete successfully
    expect(events2.find((e) => e.type === 'done')).toBeDefined();

    // First run should NOT have a done event (it was aborted)
    const done1 = events1.find((e) => e.type === 'done');
    const images1 = events1.filter((e) => e.type === 'image');
    // It either has no done, or completed fewer than 50 images
    if (done1) {
      expect(images1.length).toBeLessThan(50);
    }
  });

  it('client disconnect stops the run gracefully', async () => {
    // Start a run and abort it almost immediately (before open finishes)
    const events = await collectSSE(`${baseUrl}/api/run/channel?count=100`, {
      abortAfterMs: 5,
    });

    // Should not have completed all images (aborted during open or early)
    const done = events.find((e) => e.type === 'done');
    const images = events.filter((e) => e.type === 'image');
    expect(done === undefined || images.length < 100).toBe(true);

    // Server should recover — next run should work
    await sleep(50);
    const events2 = await collectSSE(`${baseUrl}/api/run/channel?count=2`);
    expect(events2.find((e) => e.type === 'done')).toBeDefined();
  });

  it('three sequential runs all complete', async () => {
    for (let i = 0; i < 3; i++) {
      const events = await collectSSE(`${baseUrl}/api/run/channel?count=2`);
      const done = events.find((e) => e.type === 'done');
      expect(done, `run ${i + 1} should complete`).toBeDefined();
      expect(done!.count).toBe(2);
    }
  });

  it('opened status includes txHash', async () => {
    const events = await collectSSE(`${baseUrl}/api/run/channel?count=1`);
    const opened = events.find((e) => e.type === 'status' && e.phase === 'opened');
    expect(opened).toBeDefined();
    expect(opened!.txHash).toBeTruthy();
  });
});
