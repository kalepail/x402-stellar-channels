/**
 * Soroban contract invocation via raw fetch() RPC calls.
 *
 * The Stellar SDK's rpc.Server uses axios internally, which doesn't work
 * in Cloudflare Workers. This module uses the SDK only for XDR/crypto
 * and makes RPC calls via native fetch().
 */

import {
  Account,
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

// ── Config ──────────────────────────────────────────────────────────────────

let rpcUrl = 'https://soroban-rpc.testnet.stellar.gateway.fm';
let networkPassphrase = Networks.TESTNET;

/** Configure RPC connection. Call before first use in Workers. */
export function configureStellar(url: string, network: string): void {
  rpcUrl = url;
  networkPassphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}

// ── Raw RPC helpers (fetch-based, Workers-compatible) ────────────────────────

interface JsonRpcResponse<T = unknown> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: string };
}

async function rpcCall<T = unknown>(method: string, params?: unknown): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!resp.ok) {
    throw new Error(`RPC ${method}: HTTP ${resp.status} ${await resp.text()}`);
  }
  const json = (await resp.json()) as JsonRpcResponse<T>;
  if (json.error) {
    throw new Error(`RPC ${method}: ${json.error.message} ${json.error.data || ''}`);
  }
  return json.result as T;
}

interface GetAccountResult {
  entries: Array<{ xdr: string; lastModifiedLedgerSeq: number }>;
  latestLedger: number;
}

async function getAccount(publicKey: string): Promise<Account> {
  const ledgerKey = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: Keypair.fromPublicKey(publicKey).xdrPublicKey(),
    }),
  );
  const result = await rpcCall<GetAccountResult>('getLedgerEntries', {
    keys: [ledgerKey.toXDR('base64')],
  });
  if (!result.entries || result.entries.length === 0) {
    throw new Error(`Account not found: ${publicKey}`);
  }
  const entry = xdr.LedgerEntryData.fromXDR(result.entries[0].xdr, 'base64');
  const seqNum = entry.account().seqNum().toString();
  return new Account(publicKey, seqNum);
}

async function simulateTransaction(
  tx: ReturnType<TransactionBuilder['build']>,
): Promise<StellarRpc.Api.SimulateTransactionResponse> {
  const raw = await rpcCall<StellarRpc.Api.RawSimulateTransactionResponse>('simulateTransaction', {
    transaction: tx.toXDR(),
  });
  return StellarRpc.parseRawSimulation(raw);
}

interface SendResult {
  hash: string;
  status: string;
  errorResultXdr?: string;
}

async function sendTransaction(tx: { toXDR(): string }): Promise<SendResult> {
  return rpcCall<SendResult>('sendTransaction', {
    transaction: tx.toXDR(),
  });
}

interface GetTxResult {
  status: string;
  resultXdr?: string;
  resultMetaXdr?: string;
  ledger?: number;
}

async function getTransaction(hash: string): Promise<GetTxResult> {
  return rpcCall<GetTxResult>('getTransaction', { hash });
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
  const account = await getAccount(agentKeypair.publicKey());
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

  // Simulate to get resource estimates + auth entries
  const sim = await simulateTransaction(innerTx);
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
    networkPassphrase,
  );
  feeBump.sign(relayerKeypair);

  // Submit the fee-bumped transaction
  const result = await sendTransaction(feeBump);
  if (result.status === 'ERROR') throw new Error(`submit error: ${JSON.stringify(result)}`);

  // Poll for confirmation
  let txResult = await getTransaction(result.hash);
  while (txResult.status === 'NOT_FOUND') {
    await new Promise((r) => setTimeout(r, 1500));
    txResult = await getTransaction(result.hash);
  }
  if (txResult.status === 'FAILED') {
    throw new Error(`tx failed: ${JSON.stringify(txResult)}`);
  }
  return result.hash;
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
