import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  signState,
  verifyState,
  stateMessage,
  deriveChannelId,
  pubkeyBytes,
} from '../src/crypto.js';

describe('stateMessage', () => {
  it('produces 72-byte output', () => {
    const channelId = Buffer.alloc(32, 0x01);
    const msg = stateMessage(channelId, 42n, 990000n, 10000n);
    expect(msg.length).toBe(72);
  });

  it('encodes channel_id in first 32 bytes', () => {
    const channelId = Buffer.alloc(32, 0xab);
    const msg = stateMessage(channelId, 1n, 990000n, 10000n);
    expect(msg.slice(0, 32)).toEqual(channelId);
  });

  it('encodes iteration as 8 bytes at offset 32', () => {
    const channelId = Buffer.alloc(32, 0x00);
    const msg = stateMessage(channelId, 1n, 0n, 0n);
    expect(msg.readBigUInt64BE(32)).toBe(1n);
  });

  it('different iteration → different message', () => {
    const channelId = Buffer.alloc(32, 0x01);
    const m1 = stateMessage(channelId, 1n, 990000n, 10000n);
    const m2 = stateMessage(channelId, 2n, 980000n, 20000n);
    expect(m1.equals(m2)).toBe(false);
  });

  it('same inputs → identical messages (deterministic)', () => {
    const channelId = Buffer.alloc(32, 0x77);
    const m1 = stateMessage(channelId, 5n, 500n, 500n);
    const m2 = stateMessage(channelId, 5n, 500n, 500n);
    expect(m1.equals(m2)).toBe(true);
  });
});

describe('signState / verifyState', () => {
  it('round-trip: sign then verify succeeds', () => {
    const kp = Keypair.random();
    const channelId = Buffer.alloc(32, 0xab);
    const sig = signState(kp, channelId, 5n, 950000n, 50000n);
    expect(sig.length).toBe(64);
    expect(() => verifyState(kp.publicKey(), sig, channelId, 5n, 950000n, 50000n)).not.toThrow();
  });

  it('wrong public key throws', () => {
    const kp = Keypair.random();
    const other = Keypair.random();
    const channelId = Buffer.alloc(32, 0x01);
    const sig = signState(kp, channelId, 1n, 990000n, 10000n);
    expect(() => verifyState(other.publicKey(), sig, channelId, 1n, 990000n, 10000n)).toThrow();
  });

  it('tampered balance throws', () => {
    const kp = Keypair.random();
    const channelId = Buffer.alloc(32, 0x01);
    const sig = signState(kp, channelId, 1n, 990000n, 10000n);
    expect(() => verifyState(kp.publicKey(), sig, channelId, 1n, 980000n, 20000n)).toThrow();
  });

  it('tampered iteration throws', () => {
    const kp = Keypair.random();
    const channelId = Buffer.alloc(32, 0x01);
    const sig = signState(kp, channelId, 3n, 990000n, 10000n);
    expect(() => verifyState(kp.publicKey(), sig, channelId, 4n, 990000n, 10000n)).toThrow();
  });

  it('large bigint balances round-trip correctly', () => {
    const kp = Keypair.random();
    const channelId = Buffer.alloc(32, 0x01);
    const large = 100_000_000_000_000n;
    const sig = signState(kp, channelId, 1000n, large, large);
    expect(() => verifyState(kp.publicKey(), sig, channelId, 1000n, large, large)).not.toThrow();
  });
});

describe('deriveChannelId', () => {
  it('produces 32-byte output', async () => {
    const pk = pubkeyBytes(Keypair.random().publicKey());
    const nonce = new Uint8Array(32);
    const id = await deriveChannelId(pk, nonce);
    expect(id.length).toBe(32);
  });

  it('different nonce → different channel_id', async () => {
    const pk = pubkeyBytes(Keypair.random().publicKey());
    const n1 = new Uint8Array(32).fill(1);
    const n2 = new Uint8Array(32).fill(2);
    const id1 = await deriveChannelId(pk, n1);
    const id2 = await deriveChannelId(pk, n2);
    expect(id1.equals(id2)).toBe(false);
  });

  it('same inputs → same channel_id (deterministic)', async () => {
    const pk = pubkeyBytes(Keypair.random().publicKey());
    const nonce = new Uint8Array(32).fill(0xaa);
    const id1 = await deriveChannelId(pk, nonce);
    const id2 = await deriveChannelId(pk, nonce);
    expect(id1.equals(id2)).toBe(true);
  });
});
