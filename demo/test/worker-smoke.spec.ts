/**
 * Smoke tests for the Hono worker — tests routes without live testnet.
 * Uses Hono's built-in app.request() for in-process testing.
 */

import { describe, it, expect } from 'vitest';
import app from '../src/worker.js';

// Valid (but unfunded) test keypairs
const mockEnv = {
  ASSETS: {} as Fetcher,
  AGENT_SECRET: 'SCD3OPVE2G6ZPAXQZO57CHZ7XXNB7BSEQ5HXDBXGLSTCQUBW65VGZOLP',
  FACILITATOR_SECRET: 'SCD3OPVE2G6ZPAXQZO57CHZ7XXNB7BSEQ5HXDBXGLSTCQUBW65VGZOLP',
  CHANNEL_SERVER_PUBLIC: 'GCRCUDYPRUODZDVUYDRAVIJ4M3RMDM2WLNA24ENDO62QX2ATZ4E7BAGU',
  NFT_SERVICE_PAY_TO: 'GCRCUDYPRUODZDVUYDRAVIJ4M3RMDM2WLNA24ENDO62QX2ATZ4E7BAGU',
  NFT_SERVICE_URL: 'https://x402-nft-service.sdf-ecosystem.workers.dev',
  USDC_CONTRACT_ID: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  CHANNEL_CONTRACT_ID: 'CBMUDNVJSVXUKIBAUTLT3R2XTLBM6SVRRXN6T7VG72XMKWV5JNDCRCZ2',
  NETWORK: 'testnet',
  RPC_URL: 'https://soroban-testnet.stellar.org',
};

/** Parse SSE events from a response body. */
async function parseSSE(resp: Response): Promise<Array<Record<string, unknown>>> {
  const text = await resp.text();
  const events: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}

describe('Worker routes', () => {
  it('GET /api/run/vanilla returns SSE with correct content-type', async () => {
    const resp = await app.request('/api/run/vanilla?count=1', {}, mockEnv);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
  });

  it('GET /api/run/vanilla streams status + image + done events', async () => {
    const resp = await app.request('/api/run/vanilla?count=1', {}, mockEnv);
    const events = await parseSSE(resp);

    const types = events.map((e) => e.type);
    expect(types).toContain('status');
    expect(types).toContain('image');
    expect(types).toContain('done');

    const image = events.find((e) => e.type === 'image')!;
    expect(image.svg).toBeDefined();
    expect(String(image.svg)).toContain('<svg');

    const done = events.find((e) => e.type === 'done')!;
    expect(done.count).toBe(1);
    expect(done.onChainTxs).toBe(1);
  }, 15_000); // vanilla endpoint sleeps 5s per image

  it('GET /api/run/channel returns SSE stream', async () => {
    const resp = await app.request('/api/run/channel?count=1', {}, mockEnv);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
  });

  it('GET /api/run/channel emits opening status then error (unfunded account)', async () => {
    const resp = await app.request('/api/run/channel?count=1', {}, mockEnv);
    const events = await parseSSE(resp);

    // Should get the opening status
    const opening = events.find((e) => e.type === 'status' && e.phase === 'opening');
    expect(opening).toBeDefined();

    // Will get an error because mock keys aren't funded
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(error!.fatal).toBe(true);
  }, 30_000); // Soroban RPC calls may take time

  it('GET unknown route returns 404', async () => {
    const resp = await app.request('/api/nonexistent', {}, mockEnv);
    expect(resp.status).toBe(404);
  });
});
