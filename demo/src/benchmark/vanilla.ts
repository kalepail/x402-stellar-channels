import { VanillaClient } from '../client/vanilla-client.js';
import { measure, type BenchmarkResult, type TimedResult } from './timer.js';

export async function runVanillaBenchmark(calls: number): Promise<BenchmarkResult> {
  const client = new VanillaClient(
    `http://localhost:${process.env.SERVER_PORT ?? 3001}`,
    process.env.AGENT_SECRET!,
    `http://localhost:${process.env.FACILITATOR_PORT ?? 3002}`,
    process.env.TOKEN_CONTRACT_ID!,
  );

  const results: TimedResult[] = [];
  for (let i = 1; i <= calls; i++) {
    const r = await measure(`Call ${String(i).padStart(2, ' ')}`, () => client.get('/data').then(() => {}));
    results.push(r);
    if (!r.success) console.error(`  ✗ Call ${i}: ${r.error}`);
  }

  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
  return {
    mode: 'vanilla',
    calls,
    results,
    totalMs,
    perCallAvgMs: Math.round(totalMs / calls),
  };
}
