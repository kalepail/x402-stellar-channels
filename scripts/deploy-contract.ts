import { execSync } from 'child_process';
import { existsSync } from 'fs';

export function deployContract(
  wasmPath: string,
  sourceSecret: string,
  network = 'testnet',
): string {
  if (!existsSync(wasmPath)) {
    throw new Error(`WASM not found at ${wasmPath}. Run: cd contract && stellar contract build`);
  }
  const output = execSync(
    `stellar contract deploy --wasm ${wasmPath} --source ${sourceSecret} --network ${network}`,
    { encoding: 'utf8' },
  ).trim();
  const contractId = output.split('\n').find((l) => l.startsWith('C'));
  if (!contractId) throw new Error(`Could not parse contract ID from output:\n${output}`);
  return contractId;
}
