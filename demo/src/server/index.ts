import express from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { channelPaymentMiddleware, registerChannel } from './middleware.js';
import type { ChannelInfo } from '../types.js';

const app = express();
app.use(express.json());

const serverKeypair = Keypair.fromSecret(process.env.SERVER_SECRET!);
const PRICE = 1000n; // 0.0001 USDC

app.use(
  '/data',
  channelPaymentMiddleware({
    serverKeypair,
    price: PRICE,
    assetContractId: process.env.TOKEN_CONTRACT_ID!,
    channelContractId: process.env.CHANNEL_CONTRACT_ID!,
    facilitatorUrl: `http://localhost:${process.env.FACILITATOR_PORT ?? 3002}`,
  }),
);

app.post('/channel/register', (req, res) => {
  const raw = req.body;
  const info: ChannelInfo = {
    ...raw,
    deposit: BigInt(raw.deposit),
    currentState: {
      ...raw.currentState,
      iteration: BigInt(raw.currentState.iteration),
      agentBalance: BigInt(raw.currentState.agentBalance),
      serverBalance: BigInt(raw.currentState.serverBalance),
    },
  };
  registerChannel(info);
  res.json({ ok: true });
});

app.get('/data', (_req, res) => {
  res.json({ result: 'This is paid content', ts: Date.now() });
});

const PORT = process.env.SERVER_PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`API server on :${PORT} — pubkey: ${serverKeypair.publicKey()}`);
});
