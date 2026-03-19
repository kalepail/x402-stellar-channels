/**
 * Soroban contract invocation using the Stellar SDK's rpc.Server.
 */

import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  BASE_FEE,
  nativeToScVal,
  Address,
  xdr,
  StrKey,
  rpc,
} from '@stellar/stellar-sdk';
import type { ChannelState } from '../types.js';

// ── Config ──────────────────────────────────────────────────────────────────

let server: rpc.Server;
let networkPassphrase = Networks.TESTNET;

/** Configure RPC connection. Call before first use in Workers. */
export function configureStellar(url: string, network: string): void {
  server = new rpc.Server(url);
  networkPassphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}

// ── Contract invocation with fee-bump relaying ───────────────────────────────

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
  const account = await server.getAccount(agentKeypair.publicKey());
  const innerTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
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

  // Simulate + assemble (prepareTransaction does both in one call)
  const assembled = await server.prepareTransaction(innerTx);
  assembled.sign(agentKeypair);

  // Wrap in fee-bump: relayer pays all XLM fees
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    relayerKeypair,
    String(Number(assembled.fee) * 2 + 100000),
    assembled,
    networkPassphrase,
  );
  feeBump.sign(relayerKeypair);

  // Submit the fee-bumped transaction
  const sendResult = await server.sendTransaction(feeBump);
  if (sendResult.status === 'ERROR') throw new Error(`submit error: ${JSON.stringify(sendResult)}`);

  // Poll for confirmation (max ~30s to avoid spinning forever if RPC is down)
  const MAX_POLL_ATTEMPTS = 20;
  let txResult = await server.getTransaction(sendResult.hash);
  let pollAttempt = 0;
  while (txResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    pollAttempt++;
    if (pollAttempt >= MAX_POLL_ATTEMPTS) {
      throw new Error(
        `tx ${sendResult.hash} not confirmed after ${MAX_POLL_ATTEMPTS} polls (~30s)`,
      );
    }
    await new Promise((r) => setTimeout(r, 1500));
    txResult = await server.getTransaction(sendResult.hash);
  }
  if (txResult.status === rpc.Api.GetTransactionStatus.FAILED) {
    throw new Error(`tx failed: ${JSON.stringify(txResult)}`);
  }
  return sendResult.hash;
}

// ── High-level channel operations ────────────────────────────────────────────

/**
 * Open a payment channel on-chain.
 *
 * @param serverPayTo     G... address that receives server_balance on close
 * @param serverSigningKey G... public key the server uses to counter-sign states
 */
export async function openChannelOnChain(
  facilitatorKeypair: Keypair,
  agentKeypair: Keypair,
  serverPayTo: string,
  serverSigningKey: string | undefined,
  assetContractId: string,
  channelContractId: string,
  deposit: bigint,
  nonce: Uint8Array,
): Promise<string> {
  const agentPubkeyBytes = StrKey.decodeEd25519PublicKey(agentKeypair.publicKey());
  const signingKey = serverSigningKey || serverPayTo;
  const serverPubkeyBytes = StrKey.decodeEd25519PublicKey(signingKey);

  const args = [
    new Address(agentKeypair.publicKey()).toScVal(),
    xdr.ScVal.scvBytes(agentPubkeyBytes),
    new Address(serverPayTo).toScVal(),
    xdr.ScVal.scvBytes(serverPubkeyBytes),
    new Address(assetContractId).toScVal(),
    nativeToScVal(deposit, { type: 'i128' }),
    xdr.ScVal.scvBytes(Buffer.from(nonce)),
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
