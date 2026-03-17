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

const RPC_URL = process.env.RPC_URL ?? 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE =
  process.env.NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
const server = new StellarRpc.Server(RPC_URL);

async function invokeContract(
  sourceKeypair: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<string> {
  const account = await server.getAccount(sourceKeypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
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

  const sim = await server.simulateTransaction(tx);
  if (StellarRpc.Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }

  const assembled = StellarRpc.assembleTransaction(tx, sim).build();
  assembled.sign(sourceKeypair);

  const result = await server.sendTransaction(assembled);
  if (result.status === 'ERROR') throw new Error(`submit error: ${JSON.stringify(result)}`);

  let response = await server.getTransaction(result.hash);
  while (response.status === StellarRpc.Api.GetTransactionStatus.NOT_FOUND) {
    await new Promise((r) => setTimeout(r, 1500));
    response = await server.getTransaction(result.hash);
  }
  if (response.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error(`tx failed: ${JSON.stringify(response)}`);
  }
  return result.hash;
}

export async function openChannelOnChain(
  facilitatorKeypair: Keypair,
  agentKeypair: Keypair, // facilitator holds agent's key for demo; real app uses separate auth
  serverPublic: string,
  serverPubkeyHex: string,
  assetContractId: string,
  channelContractId: string,
  deposit: bigint,
  nonce: Buffer,
): Promise<string> {
  const agentPubkeyBytes = Buffer.from(StrKey.decodeEd25519PublicKey(agentKeypair.publicKey()));
  const serverPubkeyBytes = Buffer.from(StrKey.decodeEd25519PublicKey(serverPublic));

  const args = [
    new Address(agentKeypair.publicKey()).toScVal(),
    xdr.ScVal.scvBytes(agentPubkeyBytes),
    new Address(serverPublic).toScVal(),
    xdr.ScVal.scvBytes(serverPubkeyBytes),
    new Address(assetContractId).toScVal(),
    nativeToScVal(deposit, { type: 'i128' }),
    xdr.ScVal.scvBytes(nonce),
  ];

  // For demo: facilitator signs on behalf of agent (agent's keypair is available)
  // In production: agent signs their auth entry separately
  return invokeContract(agentKeypair, channelContractId, 'open_channel', args);
}

export async function closeChannelOnChain(
  agentKeypair: Keypair,
  channelContractId: string,
  state: ChannelState,
  agentSig: Buffer,
  serverSig: Buffer,
): Promise<string> {
  const channelIdBytes = Buffer.from(state.channelId, 'hex');
  const stateScVal = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('agent_balance'), val: nativeToScVal(state.agentBalance, { type: 'i128' }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('channel_id'), val: xdr.ScVal.scvBytes(channelIdBytes) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('iteration'), val: nativeToScVal(state.iteration, { type: 'u64' }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('server_balance'), val: nativeToScVal(state.serverBalance, { type: 'i128' }) }),
  ]);
  const args = [
    xdr.ScVal.scvBytes(channelIdBytes),
    stateScVal,
    xdr.ScVal.scvBytes(agentSig),
    xdr.ScVal.scvBytes(serverSig),
  ];
  return invokeContract(agentKeypair, channelContractId, 'close_channel', args);
}
