import { execSync } from 'child_process';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { writeFileSync } from 'fs';
import { deployContract } from './deploy-contract.js';

async function fundViaFriendbot(publicKey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) throw new Error(`Friendbot failed for ${publicKey}: ${await res.text()}`);
}

async function main(): Promise<void> {
  console.log('=== x402 Stellar Channels — Testnet Setup ===\n');

  const agent = Keypair.random();
  const server = Keypair.random();
  const facilitator = Keypair.random();

  console.log('Generated keypairs:');
  console.log(`  Agent:       ${agent.publicKey()}`);
  console.log(`  Server:      ${server.publicKey()}`);
  console.log(`  Facilitator: ${facilitator.publicKey()}`);

  console.log('\nFunding via Friendbot...');
  await Promise.all([
    fundViaFriendbot(agent.publicKey()),
    fundViaFriendbot(server.publicKey()),
    fundViaFriendbot(facilitator.publicKey()),
  ]);
  console.log('  All accounts funded.');

  // Deploy native XLM as a Soroban token (SAC)
  console.log('\nDeploying native XLM token contract (SAC)...');
  const tokenOutput = execSync(
    `stellar contract asset deploy --asset native --source ${facilitator.secret()} --network testnet`,
    { encoding: 'utf8' },
  ).trim();
  const tokenContractId = tokenOutput.split('\n').find((l) => l.startsWith('C'));
  if (!tokenContractId) throw new Error(`Could not parse token contract ID:\n${tokenOutput}`);
  console.log(`  Token contract: ${tokenContractId}`);

  // Build and deploy channel contract
  console.log('\nBuilding channel contract...');
  execSync('cd contract && stellar contract build', { encoding: 'utf8', stdio: 'inherit' });

  console.log('\nDeploying channel contract...');
  const channelContractId = deployContract(
    'contract/target/wasm32-unknown-unknown/release/x402_channel.wasm',
    facilitator.secret(),
  );
  console.log(`  Channel contract: ${channelContractId}`);

  const env = [
    `AGENT_SECRET=${agent.secret()}`,
    `AGENT_PUBLIC=${agent.publicKey()}`,
    `SERVER_SECRET=${server.secret()}`,
    `SERVER_PUBLIC=${server.publicKey()}`,
    `FACILITATOR_SECRET=${facilitator.secret()}`,
    `FACILITATOR_PUBLIC=${facilitator.publicKey()}`,
    `TOKEN_CONTRACT_ID=${tokenContractId}`,
    `CHANNEL_CONTRACT_ID=${channelContractId}`,
    `NETWORK=testnet`,
    `RPC_URL=https://soroban-testnet.stellar.org`,
    `HORIZON_URL=https://horizon-testnet.stellar.org`,
    `SERVER_PORT=3001`,
    `FACILITATOR_PORT=3002`,
    `BENCHMARK_CALLS=20`,
  ].join('\n');

  writeFileSync('.env.testnet', env + '\n');
  console.log('\n.env.testnet written (keep this secret).\n');
  console.log('Next steps:');
  console.log('  cd demo');
  console.log('  npm run facilitator   # terminal 1');
  console.log('  npm run server        # terminal 2');
  console.log('  npm run benchmark     # terminal 3');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
