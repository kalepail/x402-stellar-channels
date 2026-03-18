import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  rpc as StellarRpc,
  BASE_FEE,
  nativeToScVal,
  Address,
  xdr,
  StrKey,
} from '@stellar/stellar-sdk';
import type { ChannelState } from '../types.js';

/** Mutable config — call configureStellar() in Workers before first use. */
const stellar = {
  rpcUrl:
    (typeof process !== 'undefined' ? process.env?.RPC_URL : undefined) ??
    'https://soroban-testnet.stellar.org',
  networkPassphrase:
    typeof process !== 'undefined' && process.env?.NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET,
  server: null as unknown as StellarRpc.Server,
};
stellar.server = new StellarRpc.Server(stellar.rpcUrl);

/** Configure RPC connection (call once at startup in Workers where process.env isn't available). */
export function configureStellar(rpcUrl: string, network: string): void {
  stellar.rpcUrl = rpcUrl;
  stellar.networkPassphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  stellar.server = new StellarRpc.Server(rpcUrl);
}

export { stellar };

/**
 * Invoke a contract with fee-bump relaying.
 *
 * The agent signs the inner transaction (authorizes the contract call),
 * and the relayer wraps it in a fee-bump transaction so the relayer's
 * account pays all XLM fees. The agent never spends XLM on fees.
 */
async function invokeContractRelayed(
  relayerKeypair: Keypair,
  agentKeypair: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<string> {
  // Build inner tx with agent as source (needed for require_auth + sequence)
  const account = await stellar.server.getAccount(agentKeypair.publicKey());
  const innerTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: stellar.networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: method,
        args,
      }),
    )
    .setTimeout(30)
    .build();

  // Simulate to get resource estimates + auth entries
  const sim = await stellar.server.simulateTransaction(innerTx);
  if (StellarRpc.Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }

  // Assemble — auth entries for agent are auto-satisfied since agent is source
  const assembled = StellarRpc.assembleTransaction(innerTx, sim).build();
  assembled.sign(agentKeypair);

  // Wrap in fee-bump: relayer pays all XLM fees
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    relayerKeypair,
    String(Number(assembled.fee) * 2 + 100000),
    assembled,
    stellar.networkPassphrase,
  );
  feeBump.sign(relayerKeypair);

  // Submit the fee-bumped transaction
  const result = await stellar.server.sendTransaction(feeBump);
  if (result.status === 'ERROR') throw new Error(`submit error: ${JSON.stringify(result)}`);

  let response = await stellar.server.getTransaction(result.hash);
  while (response.status === StellarRpc.Api.GetTransactionStatus.NOT_FOUND) {
    await new Promise((r) => setTimeout(r, 1500));
    response = await stellar.server.getTransaction(result.hash);
  }
  if (response.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error(`tx failed: ${JSON.stringify(response)}`);
  }
  return result.hash;
}

/**
 * Open a payment channel on-chain.
 *
 * The facilitator acts as a fee relayer — agent signs the contract
 * invocation (authorizing the USDC deposit), facilitator pays XLM fees
 * via a fee-bump transaction.
 *
 * @param serverPayTo     G... address that receives server_balance on close
 * @param serverSigningKey G... public key the server uses to counter-sign states
 *                         (defaults to serverPayTo if not provided — for the NFT
 *                          service these are different: payTo is the merchant,
 *                          signingKey is CHANNEL_SERVER_SECRET's public key)
 */
export async function openChannelOnChain(
  facilitatorKeypair: Keypair,
  agentKeypair: Keypair,
  serverPayTo: string,
  serverSigningKey: string | undefined,
  assetContractId: string,
  channelContractId: string,
  deposit: bigint,
  nonce: Buffer,
): Promise<string> {
  const agentPubkeyBytes = Buffer.from(StrKey.decodeEd25519PublicKey(agentKeypair.publicKey()));
  const signingKey = serverSigningKey || serverPayTo;
  const serverPubkeyBytes = Buffer.from(StrKey.decodeEd25519PublicKey(signingKey));

  const args = [
    new Address(agentKeypair.publicKey()).toScVal(),
    xdr.ScVal.scvBytes(agentPubkeyBytes),
    new Address(serverPayTo).toScVal(),
    xdr.ScVal.scvBytes(serverPubkeyBytes),
    new Address(assetContractId).toScVal(),
    nativeToScVal(deposit, { type: 'i128' }),
    xdr.ScVal.scvBytes(nonce),
  ];

  return invokeContractRelayed(
    facilitatorKeypair,
    agentKeypair,
    channelContractId,
    'open_channel',
    args,
  );
}

/**
 * Close a payment channel on-chain, settling final balances.
 *
 * Uses fee-bump relaying so the facilitator pays XLM fees.
 * close_channel has no require_auth — anyone can submit the final
 * mutually-signed state. We use the agent as inner source for consistency.
 */
export async function closeChannelOnChain(
  facilitatorKeypair: Keypair,
  agentKeypair: Keypair,
  channelContractId: string,
  state: ChannelState,
  agentSig: Buffer,
  serverSig: Buffer,
): Promise<string> {
  const channelIdBytes = Buffer.from(state.channelId, 'hex');
  const stateScVal = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('agent_balance'),
      val: nativeToScVal(state.agentBalance, { type: 'i128' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('channel_id'),
      val: xdr.ScVal.scvBytes(channelIdBytes),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('iteration'),
      val: nativeToScVal(state.iteration, { type: 'u64' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('server_balance'),
      val: nativeToScVal(state.serverBalance, { type: 'i128' }),
    }),
  ]);
  const args = [
    xdr.ScVal.scvBytes(channelIdBytes),
    stateScVal,
    xdr.ScVal.scvBytes(agentSig),
    xdr.ScVal.scvBytes(serverSig),
  ];
  return invokeContractRelayed(
    facilitatorKeypair,
    agentKeypair,
    channelContractId,
    'close_channel',
    args,
  );
}
