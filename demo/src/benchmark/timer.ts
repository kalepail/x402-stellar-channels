export interface TimedResult {
  label: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface BenchmarkResult {
  mode: 'vanilla' | 'channel';
  calls: number;
  results: TimedResult[];
  overheadMs?: number;
  totalMs: number;
  perCallAvgMs: number;
}

export async function measure(label: string, fn: () => Promise<void>): Promise<TimedResult> {
  const start = performance.now();
  try {
    await fn();
    return { label, durationMs: Math.round(performance.now() - start), success: true };
  } catch (err) {
    return { label, durationMs: Math.round(performance.now() - start), success: false, error: String(err) };
  }
}
