import { Keypair } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { signState, verifyState, deriveChannelId, pubkeyBytes } from '../crypto.js';
import type { ChannelInfo, ChannelPaymentHeader, ChannelPaymentResponse } from '../types.js';

interface ChannelClientOptions {
  agentKeypair: Keypair;
  serverPublic: string;
  assetContractId: string;
  channelContractId: string;
  facilitatorUrl: string;
  serverUrl: string;
  pricePerCall: bigint;
  deposit: bigint;
}

export class ChannelClient {
  private channel: ChannelInfo | null = null;

  constructor(private opts: ChannelClientOptions) {}

  async open(): Promise<void> {
    const nonce = randomBytes(32);
    const agentPkBytes = pubkeyBytes(this.opts.agentKeypair.publicKey());
    const serverPkBytes = pubkeyBytes(this.opts.serverPublic);
    const channelIdBuf = deriveChannelId(agentPkBytes, nonce);
    const channelId = channelIdBuf.toString('hex');

    const res = await fetch(`${this.opts.facilitatorUrl}/channel/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverPublic: this.opts.serverPublic,
        serverPubkeyHex: serverPkBytes.toString('hex'),
        assetContractId: this.opts.assetContractId,
        deposit: String(this.opts.deposit),
        nonce: nonce.toString('hex'),
      }),
    });
    if (!res.ok) throw new Error(`open failed: ${await res.text()}`);

    this.channel = {
      channelId,
      agentPublic: this.opts.agentKeypair.publicKey(),
      agentPubkeyHex: agentPkBytes.toString('hex'),
      serverPublic: this.opts.serverPublic,
      serverPubkeyHex: serverPkBytes.toString('hex'),
      assetContractId: this.opts.assetContractId,
      deposit: this.opts.deposit,
      currentState: {
        channelId,
        iteration: 0n,
        agentBalance: this.opts.deposit,
        serverBalance: 0n,
      },
    };

    // Register channel with API server so it can verify payments
    await fetch(`${this.opts.serverUrl}/channel/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.channel, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    });
  }

  async get(path: string): Promise<unknown> {
    if (!this.channel) throw new Error('channel not open — call open() first');

    const prev = this.channel.currentState;
    const newIteration = prev.iteration + 1n;
    const newAgentBalance = prev.agentBalance - this.opts.pricePerCall;
    const newServerBalance = prev.serverBalance + this.opts.pricePerCall;

    if (newAgentBalance < 0n) throw new Error('channel balance exhausted');

    const channelIdBuf = Buffer.from(this.channel.channelId, 'hex');
    const agentSig = signState(
      this.opts.agentKeypair,
      channelIdBuf,
      newIteration,
      newAgentBalance,
      newServerBalance,
    );

    const header: ChannelPaymentHeader = {
      scheme: 'channel',
      channelId: this.channel.channelId,
      iteration: String(newIteration),
      agentBalance: String(newAgentBalance),
      serverBalance: String(newServerBalance),
      agentSig: agentSig.toString('hex'),
    };

    const res = await fetch(`${this.opts.serverUrl}${path}`, {
      headers: { 'X-Payment': JSON.stringify(header) },
    });
    if (!res.ok) throw new Error(`request failed ${res.status}: ${await res.text()}`);

    const respHeaderRaw = res.headers.get('X-Payment-Response');
    if (respHeaderRaw) {
      const parsed = JSON.parse(respHeaderRaw) as ChannelPaymentResponse;
      const serverSig = Buffer.from(parsed.serverSig, 'hex');
      verifyState(
        this.opts.serverPublic,
        serverSig,
        channelIdBuf,
        newIteration,
        newAgentBalance,
        newServerBalance,
      );
      this.channel.serverLastSig = serverSig;
    }

    this.channel.agentLastSig = agentSig;
    this.channel.currentState = {
      channelId: this.channel.channelId,
      iteration: newIteration,
      agentBalance: newAgentBalance,
      serverBalance: newServerBalance,
    };

    return res.json();
  }

  /** Returns the final state info needed for close, without actually closing on-chain. */
  getFinalState(): {
    channelId: string;
    iteration: bigint;
    agentBalance: bigint;
    serverBalance: bigint;
    agentLastSig: Buffer;
    serverLastSig: Buffer;
  } {
    if (!this.channel?.agentLastSig || !this.channel?.serverLastSig) {
      throw new Error('no paid requests made — nothing to close');
    }
    return {
      channelId: this.channel.channelId,
      iteration: this.channel.currentState.iteration,
      agentBalance: this.channel.currentState.agentBalance,
      serverBalance: this.channel.currentState.serverBalance,
      agentLastSig: this.channel.agentLastSig,
      serverLastSig: this.channel.serverLastSig,
    };
  }

  async close(): Promise<void> {
    if (!this.channel?.agentLastSig || !this.channel?.serverLastSig) {
      throw new Error('no paid requests made — nothing to close');
    }
    const res = await fetch(`${this.opts.facilitatorUrl}/channel/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: {
          channelId: this.channel.channelId,
          iteration: String(this.channel.currentState.iteration),
          agentBalance: String(this.channel.currentState.agentBalance),
          serverBalance: String(this.channel.currentState.serverBalance),
        },
        agentSig: this.channel.agentLastSig.toString('hex'),
        serverSig: this.channel.serverLastSig.toString('hex'),
      }),
    });
    if (!res.ok) throw new Error(`close failed: ${await res.text()}`);
    this.channel = null;
  }
}
