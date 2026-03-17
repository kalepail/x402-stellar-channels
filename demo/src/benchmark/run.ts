import { writeFileSync } from 'fs';
import { runVanillaBenchmark } from './vanilla.js';
import { runChannelBenchmark } from './channel.js';
import type { BenchmarkResult } from './timer.js';

const N = parseInt(process.env.BENCHMARK_CALLS ?? '20', 10);

function printResult(r: BenchmarkResult): void {
  const header = r.mode === 'vanilla'
    ? `--- Vanilla x402 (on-chain per call, ${r.calls} calls) ---`
    : `--- Channel x402 (${r.calls} calls) ---`;
  console.log(header);
  for (const t of r.results) {
    const tick = t.success ? '✓' : '✗';
    console.log(`  ${t.label.padEnd(18)}: ${String(t.durationMs).padStart(7)}ms  ${tick}`);
  }
  if (r.mode === 'channel' && r.overheadMs !== undefined) {
    console.log(`  ${'Total'.padEnd(18)}: ${String(r.totalMs).padStart(7)}ms | Per-call avg (excl. open/close): ${r.perCallAvgMs}ms`);
  } else {
    console.log(`  ${'Total'.padEnd(18)}: ${String(r.totalMs).padStart(7)}ms | Per-call avg: ${r.perCallAvgMs}ms`);
  }
  console.log('');
}

function breakEven(vanilla: BenchmarkResult, channel: BenchmarkResult): number {
  const overhead = channel.overheadMs ?? 0;
  const diff = vanilla.perCallAvgMs - channel.perCallAvgMs;
  if (diff <= 0) return Infinity;
  return Math.ceil(overhead / diff);
}

async function main(): Promise<void> {
  console.log('=== x402 Channels Benchmark — Stellar Testnet ===\n');

  console.log('Running vanilla x402...');
  const vanilla = await runVanillaBenchmark(N);
  printResult(vanilla);

  console.log('Running channel x402...');
  const channel = await runChannelBenchmark(N);
  printResult(channel);

  const be = breakEven(vanilla, channel);
  const speedupTotal = vanilla.totalMs / channel.totalMs;
  const speedupPerCall = vanilla.perCallAvgMs / (channel.perCallAvgMs || 1);

  console.log('--- Summary ---');
  console.log(`  Break-even point:         ${isFinite(be) ? `${be} calls` : 'N/A'}`);
  console.log(`  Total speedup (${N} calls): ${speedupTotal.toFixed(1)}x`);
  console.log(`  Per-call speedup:          ${speedupPerCall.toFixed(0)}x`);

  const output = { vanilla, channel, breakEven: be, speedupTotal, speedupPerCall };
  writeFileSync('benchmark-results.json', JSON.stringify(output, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v, 2));
  console.log('\nResults saved to benchmark-results.json');
}

main().catch(console.error);
