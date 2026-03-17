import { Keypair } from '@stellar/stellar-sdk';
import { ChannelClient } from '../client/channel-client.js';
import { measure, type BenchmarkResult, type TimedResult } from './timer.js';

export async function runChannelBenchmark(calls: number): Promise<BenchmarkResult> {
  const client = new ChannelClient({
    agentKeypair: Keypair.fromSecret(process.env.AGENT_SECRET!),
    serverPublic: process.env.SERVER_PUBLIC!,
    assetContractId: process.env.TOKEN_CONTRACT_ID!,
    channelContractId: process.env.CHANNEL_CONTRACT_ID!,
    facilitatorUrl: `http://localhost:${process.env.FACILITATOR_PORT ?? 3002}`,
    serverUrl: `http://localhost:${process.env.SERVER_PORT ?? 3001}`,
    pricePerCall: 1000n,
    deposit: 1_000_0000n,
  });

  const results: TimedResult[] = [];
  const openResult = await measure('Channel open', () => client.open());
  results.push(openResult);

  for (let i = 1; i <= calls; i++) {
    const r = await measure(`Call ${String(i).padStart(2, ' ')}`, () => client.get('/data').then(() => {}));
    results.push(r);
  }

  const closeResult = await measure('Channel close', () => client.close());
  results.push(closeResult);

  const callResults = results.filter((r) => r.label.startsWith('Call'));
  const overheadMs = openResult.durationMs + closeResult.durationMs;
  const callsMs = callResults.reduce((s, r) => s + r.durationMs, 0);

  return {
    mode: 'channel',
    calls,
    results,
    overheadMs,
    totalMs: overheadMs + callsMs,
    perCallAvgMs: callResults.length > 0 ? Math.round(callsMs / callResults.length) : 0,
  };
}
