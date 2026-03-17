use soroban_sdk::{Bytes, BytesN, Env};

/// Builds the canonical 72-byte state message:
/// channel_id (32 BE) || iteration (8 BE) || agent_balance (16 BE) || server_balance (16 BE)
pub fn state_msg(
    env: &Env,
    channel_id: &BytesN<32>,
    iteration: u64,
    agent_balance: i128,
    server_balance: i128,
) -> Bytes {
    let mut msg = Bytes::new(env);
    let id_arr = channel_id.to_array();
    for b in id_arr {
        msg.push_back(b);
    }
    for b in iteration.to_be_bytes() {
        msg.push_back(b);
    }
    for b in agent_balance.to_be_bytes() {
        msg.push_back(b);
    }
    for b in server_balance.to_be_bytes() {
        msg.push_back(b);
    }
    msg
}

/// Verifies an ed25519 signature over the state message.
/// Panics if invalid (traps the contract).
pub fn verify_state_sig(
    env: &Env,
    public_key: &BytesN<32>,
    channel_id: &BytesN<32>,
    iteration: u64,
    agent_balance: i128,
    server_balance: i128,
    sig: &BytesN<64>,
) {
    let msg = state_msg(env, channel_id, iteration, agent_balance, server_balance);
    env.crypto().ed25519_verify(public_key, &msg, sig);
}

/// Test/testutils-only: returns the state message as a Vec<u8> so ed25519-dalek can sign it.
#[cfg(any(test, feature = "testutils"))]
pub mod crypto_test {
    extern crate std;
    use super::*;
    pub fn state_msg_bytes(
        env: &Env,
        channel_id: &BytesN<32>,
        iteration: u64,
        agent_balance: i128,
        server_balance: i128,
    ) -> std::vec::Vec<u8> {
        state_msg(env, channel_id, iteration, agent_balance, server_balance)
            .iter()
            .collect()
    }
}
