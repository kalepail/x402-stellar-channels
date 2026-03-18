import { execSync } from 'child_process';
import { Keypair, Networks, TransactionBuilder, Horizon, Operation, Asset, BASE_FEE } from '@stellar/stellar-sdk';
import { writeFileSync } from 'fs';
import { deployContract } from './deploy-contract.js';

const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_CONTRACT_ID = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

// NFT service config (matches wrangler.jsonc)
const NFT_SERVICE_URL = 'https://x402-nft-service.sdf-ecosystem.workers.dev';
const NFT_SERVICE_PAY_TO = 'GBY77G2AKKMYAW4IVYILYYH5XCPSUL2ERKNQDV4E6QZLYEOUFRCX76IM';

async function fundViaFriendbot(publicKey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) throw new Error(`Friendbot failed for ${publicKey}: ${await res.text()}`);
}

async function addUsdcTrustline(keypair: Keypair, horizon: Horizon.Server): Promise<void> {
  const account = await horizon.loadAccount(keypair.publicKey());
  const usdcAsset = new Asset('USDC', USDC_ISSUER);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: usdcAsset }))
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  const result = await horizon.submitTransaction(tx);
  if (!result.successful) throw new Error('Trustline transaction failed');
}

async function acquireUsdc(keypair: Keypair, horizon: Horizon.Server): Promise<boolean> {
  const usdcAsset = new Asset('USDC', USDC_ISSUER);
  try {
    const paths = await horizon.strictSendPaths(Asset.native(), '100', [usdcAsset]).call();
    if (paths.records.length === 0) {
      console.log('  No DEX path found for XLM -> USDC');
      return false;
    }

    const bestPath = paths.records[0];
    console.log(`  DEX path found: 100 XLM -> ${bestPath.destination_amount} USDC`);

    const account = await horizon.loadAccount(keypair.publicKey());
    const swapTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: '100',
          destination: keypair.publicKey(),
          destAsset: usdcAsset,
          destMin: '0.0000001',
          path: bestPath.path.map(
            (p: { asset_type: string; asset_code?: string; asset_issuer?: string }) =>
              p.asset_type === 'native' ? Asset.native() : new Asset(p.asset_code!, p.asset_issuer!),
          ),
        }),
      )
      .setTimeout(30)
      .build();

    swapTx.sign(keypair);
    const result = await horizon.submitTransaction(swapTx);
    if (!result.successful) {
      console.log('  DEX swap transaction failed');
      return false;
    }
    console.log(`  Acquired ${bestPath.destination_amount} USDC via DEX swap`);
    return true;
  } catch (err) {
    console.log(`  DEX swap failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log('=== x402 Stellar Channels — Testnet Setup (USDC + NFT Service) ===\n');

  const horizon = new Horizon.Server(TESTNET_HORIZON);

  // 1. Generate keypairs
  const agent = Keypair.random();
  const facilitator = Keypair.random();
  const channelServer = Keypair.random(); // For the NFT service's CHANNEL_SERVER_SECRET

  console.log('Generated keypairs:');
  console.log(`  Agent:          ${agent.publicKey()}`);
  console.log(`  Facilitator:    ${facilitator.publicKey()}`);
  console.log(`  Channel Server: ${channelServer.publicKey()}`);

  // 2. Fund via Friendbot
  console.log('\nFunding via Friendbot...');
  await Promise.all([fundViaFriendbot(agent.publicKey()), fundViaFriendbot(facilitator.publicKey())]);
  console.log('  Agent + Facilitator funded (10,000 XLM each).');

  // 3. Add USDC trustline for agent (needs to hold USDC for channel deposits)
  console.log('\nEstablishing USDC trustline for agent...');
  await addUsdcTrustline(agent, horizon);
  console.log('  USDC trustline established.');

  // 4. Acquire USDC via DEX
  console.log('\nAcquiring USDC via testnet DEX...');
  const gotUsdc = await acquireUsdc(agent, horizon);
  if (!gotUsdc) {
    console.log('  Could not acquire USDC automatically.');
    console.log('  You can manually send USDC to the agent address, or');
    console.log('  the demo will fall back to native XLM for the channel deposit.');
  }

  // 5. Build and deploy channel contract
  console.log('\nBuilding channel contract...');
  execSync('cd ../contract && stellar contract build', { encoding: 'utf8', stdio: 'inherit' });

  console.log('\nDeploying channel contract to testnet...');
  const channelContractId = deployContract(
    '../contract/target/wasm32v1-none/release/x402_channel.wasm',
    facilitator.secret(),
  );
  console.log(`  Channel contract: ${channelContractId}`);

  // 6. Write .env.testnet
  const env = [
    `AGENT_SECRET=${agent.secret()}`,
    `AGENT_PUBLIC=${agent.publicKey()}`,
    `FACILITATOR_SECRET=${facilitator.secret()}`,
    `FACILITATOR_PUBLIC=${facilitator.publicKey()}`,
    `CHANNEL_SERVER_SECRET=${channelServer.secret()}`,
    `CHANNEL_SERVER_PUBLIC=${channelServer.publicKey()}`,
    `NFT_SERVICE_PAY_TO=${NFT_SERVICE_PAY_TO}`,
    `NFT_SERVICE_URL=${NFT_SERVICE_URL}`,
    `USDC_CONTRACT_ID=${USDC_CONTRACT_ID}`,
    `TOKEN_CONTRACT_ID=${USDC_CONTRACT_ID}`,
    `CHANNEL_CONTRACT_ID=${channelContractId}`,
    `NETWORK=testnet`,
    `RPC_URL=https://soroban-testnet.stellar.org`,
    `HORIZON_URL=${TESTNET_HORIZON}`,
    `SERVER_PORT=3001`,
    `FACILITATOR_PORT=3002`,
    `BENCHMARK_CALLS=20`,
  ].join('\n');

  writeFileSync('../.env.testnet', env + '\n');
  console.log('\n.env.testnet written.\n');

  // 7. Instructions
  console.log('=== Next Steps ===\n');
  console.log('1. Deploy the NFT service with channel support:');
  console.log(`   cd /path/to/x402-nft-service`);
  console.log(`   echo "${channelServer.secret()}" | npx wrangler secret put CHANNEL_SERVER_SECRET`);
  console.log(`   npx wrangler deploy\n`);
  console.log('2. Run the web demo:');
  console.log('   pnpm web-demo\n');
  console.log('3. Or run the benchmark:');
  console.log('   pnpm facilitator  # terminal 1');
  console.log('   pnpm api          # terminal 2');
  console.log('   pnpm benchmark    # terminal 3');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
