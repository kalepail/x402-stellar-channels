import express from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { openChannelOnChain, closeChannelOnChain } from './stellar.js';

const app = express();
app.use(express.json());

const facilitatorKeypair = Keypair.fromSecret(process.env.FACILITATOR_SECRET!);
const agentKeypair = Keypair.fromSecret(process.env.AGENT_SECRET!);
const channelContractId = process.env.CHANNEL_CONTRACT_ID!;

app.post('/channel/open', async (req, res) => {
  try {
    const { serverPublic, serverPubkeyHex, assetContractId, deposit, nonce } = req.body as {
      serverPublic: string;
      serverPubkeyHex: string;
      assetContractId: string;
      deposit: string;
      nonce: string; // hex
    };
    const txHash = await openChannelOnChain(
      facilitatorKeypair,
      agentKeypair,
      serverPublic,
      serverPubkeyHex,
      assetContractId,
      channelContractId,
      BigInt(deposit),
      Buffer.from(nonce, 'hex'),
    );
    res.json({ txHash, channelContractId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.post('/channel/close', async (req, res) => {
  try {
    const { state, agentSig, serverSig } = req.body as {
      state: { channelId: string; iteration: string; agentBalance: string; serverBalance: string };
      agentSig: string;
      serverSig: string;
    };
    const txHash = await closeChannelOnChain(
      facilitatorKeypair,
      agentKeypair,
      channelContractId,
      {
        channelId: state.channelId,
        iteration: BigInt(state.iteration),
        agentBalance: BigInt(state.agentBalance),
        serverBalance: BigInt(state.serverBalance),
      },
      Buffer.from(agentSig, 'hex'),
      Buffer.from(serverSig, 'hex'),
    );
    res.json({ txHash });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.FACILITATOR_PORT ?? 3002;
app.listen(PORT, () => console.log(`Facilitator on :${PORT}`));
