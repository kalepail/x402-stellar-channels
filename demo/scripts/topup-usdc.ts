import { Keypair, Horizon, TransactionBuilder, Operation, Asset, BASE_FEE, Networks } from '@stellar/stellar-sdk';

const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
const agent = Keypair.fromSecret(process.env.AGENT_SECRET!);
const usdcAsset = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');

async function main() {
  const acct = await horizon.loadAccount(agent.publicKey());
  const usdcBal = acct.balances.find((b) => 'asset_code' in b && b.asset_code === 'USDC');
  const xlmBal = acct.balances.find((b) => b.asset_type === 'native');
  console.log(`Agent: ${agent.publicKey()}`);
  console.log(`Current USDC: ${usdcBal ? usdcBal.balance : '0'}`);
  console.log(`Current XLM:  ${xlmBal?.balance}`);

  // Swap 2000 XLM for USDC
  const paths = await horizon.strictSendPaths(Asset.native(), '2000', [usdcAsset]).call();
  if (paths.records.length === 0) {
    console.log('No DEX path found for XLM -> USDC');
    process.exit(1);
  }
  console.log(`\nDEX path: 2000 XLM -> ${paths.records[0].destination_amount} USDC`);

  const freshAcct = await horizon.loadAccount(agent.publicKey());
  const tx = new TransactionBuilder(freshAcct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: '2000',
        destination: agent.publicKey(),
        destAsset: usdcAsset,
        destMin: '0.0000001',
        path: paths.records[0].path.map(
          (p: { asset_type: string; asset_code?: string; asset_issuer?: string }) =>
            p.asset_type === 'native' ? Asset.native() : new Asset(p.asset_code!, p.asset_issuer!),
        ),
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(agent);
  const result = await horizon.submitTransaction(tx);
  console.log(`Swap successful: ${result.successful}`);

  const after = await horizon.loadAccount(agent.publicKey());
  const usdcAfter = after.balances.find((b) => 'asset_code' in b && b.asset_code === 'USDC');
  console.log(`\nNew USDC balance: ${usdcAfter ? usdcAfter.balance : '0'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
