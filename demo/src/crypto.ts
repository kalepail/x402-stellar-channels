import { Keypair, StrKey } from '@stellar/stellar-sdk';

/**
 * Builds the canonical 72-byte state message matching the Rust contract:
 * channel_id (32 BE) || iteration (8 BE) || agent_balance (16 BE) || server_balance (16 BE)
 */
export function stateMessage(
  channelId: Buffer,
  iteration: bigint,
  agentBalance: bigint,
  serverBalance: bigint,
): Buffer {
  const buf = Buffer.alloc(72);
  channelId.copy(buf, 0);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setBigUint64(32, iteration);
  const mask64 = (1n << 64n) - 1n;
  view.setBigUint64(40, (agentBalance >> 64n) & mask64);
  view.setBigUint64(48, agentBalance & mask64);
  view.setBigUint64(56, (serverBalance >> 64n) & mask64);
  view.setBigUint64(64, serverBalance & mask64);
  return buf;
}

/** Signs the 72-byte state message with the given Stellar keypair. Returns 64-byte sig. */
export function signState(
  keypair: Keypair,
  channelId: Buffer,
  iteration: bigint,
  agentBalance: bigint,
  serverBalance: bigint,
): Buffer {
  const msg = stateMessage(channelId, iteration, agentBalance, serverBalance);
  return keypair.sign(msg);
}

export function closeIntentMessage(channelId: Buffer): Buffer {
  return Buffer.concat([channelId, Buffer.from('close', 'utf8')]);
}

export function signCloseIntent(keypair: Keypair, channelId: Buffer): Buffer {
  return keypair.sign(closeIntentMessage(channelId));
}

/**
 * Verifies a state signature. Throws if invalid.
 * publicKeyStrkey: G... Stellar public key.
 */
export function verifyState(
  publicKeyStrkey: string,
  sig: Buffer,
  channelId: Buffer,
  iteration: bigint,
  agentBalance: bigint,
  serverBalance: bigint,
): void {
  const msg = stateMessage(channelId, iteration, agentBalance, serverBalance);
  const kp = Keypair.fromPublicKey(publicKeyStrkey);
  if (!kp.verify(msg, sig)) {
    throw new Error('invalid state signature');
  }
}

export function verifyCloseIntent(
  publicKeyStrkey: string,
  sig: Buffer,
  channelId: Buffer,
): void {
  const msg = closeIntentMessage(channelId);
  const kp = Keypair.fromPublicKey(publicKeyStrkey);
  if (!kp.verify(msg, sig)) {
    throw new Error('invalid close intent signature');
  }
}

/**
 * Derives channel_id matching the contract: sha256(agent_pubkey_32 || nonce_32).
 * Uses Web Crypto API (native in CF Workers).
 */
export async function deriveChannelId(
  agentPubkeyBytes: Uint8Array,
  nonce: Uint8Array,
): Promise<Buffer> {
  const combined = new Uint8Array(agentPubkeyBytes.length + nonce.length);
  combined.set(agentPubkeyBytes);
  combined.set(nonce, agentPubkeyBytes.length);
  return Buffer.from(await crypto.subtle.digest('SHA-256', combined));
}

/** Decodes a G... strkey to raw 32-byte ed25519 public key. */
export function pubkeyBytes(strkey: string): Buffer {
  return StrKey.decodeEd25519PublicKey(strkey);
}
