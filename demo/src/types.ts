export interface ChannelState {
  channelId: string; // hex-encoded 32 bytes
  iteration: bigint;
  agentBalance: bigint; // in token's smallest unit
  serverBalance: bigint;
}
