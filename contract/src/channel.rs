use crate::types::*;
use soroban_sdk::{token, Address, Bytes, BytesN, Env};

/// channel_id = sha256(agent_pubkey_32 || nonce_32)
pub fn channel_id_from(env: &Env, agent_pubkey: &BytesN<32>, nonce: &BytesN<32>) -> BytesN<32> {
    let mut preimage = Bytes::new(env);
    for b in agent_pubkey.to_array() {
        preimage.push_back(b);
    }
    for b in nonce.to_array() {
        preimage.push_back(b);
    }
    env.crypto().sha256(&preimage).into()
}

pub fn open_channel(
    env: &Env,
    agent: Address,
    agent_pubkey: BytesN<32>,
    server: Address,
    server_pubkey: BytesN<32>,
    asset: Address,
    deposit: i128,
    nonce: BytesN<32>,
) -> BytesN<32> {
    agent.require_auth();

    let channel_id = channel_id_from(env, &agent_pubkey, &nonce);
    let token = token::Client::new(env, &asset);
    token.transfer(&agent, &env.current_contract_address(), &deposit);

    let channel = Channel {
        id: channel_id.clone(),
        agent,
        agent_pubkey,
        server,
        server_pubkey,
        asset,
        deposit,
        iteration: 0,
        agent_balance: deposit,
        server_balance: 0,
        status: ChannelStatus::Open,
        observation_end: None,
    };

    env.storage().persistent().set(&channel_id, &channel);
    env.storage()
        .persistent()
        .extend_ttl(&channel_id, CHANNEL_TTL, CHANNEL_TTL);

    channel_id
}

pub fn close_channel(
    env: &Env,
    channel_id: BytesN<32>,
    state: ChannelState,
    agent_sig: BytesN<64>,
    server_sig: BytesN<64>,
) {
    let mut channel: Channel = env
        .storage()
        .persistent()
        .get(&channel_id)
        .unwrap_or_else(|| panic!("not found: {}", ERR_NOT_FOUND));

    assert!(
        matches!(channel.status, ChannelStatus::Open),
        "not open: {}",
        ERR_NOT_OPEN
    );
    assert!(
        state.iteration >= channel.iteration,
        "bad iteration: {}",
        ERR_BAD_ITERATION
    );
    assert!(
        state.agent_balance + state.server_balance == channel.deposit,
        "bad balances: {}",
        ERR_BAD_BALANCES
    );
    assert!(
        state.agent_balance >= 0 && state.server_balance >= 0,
        "negative: {}",
        ERR_BAD_BALANCES
    );

    crate::crypto::verify_state_sig(
        env,
        &channel.agent_pubkey,
        &channel_id,
        state.iteration,
        state.agent_balance,
        state.server_balance,
        &agent_sig,
    );
    crate::crypto::verify_state_sig(
        env,
        &channel.server_pubkey,
        &channel_id,
        state.iteration,
        state.agent_balance,
        state.server_balance,
        &server_sig,
    );

    payout(env, &channel, state.agent_balance, state.server_balance);
    channel.status = ChannelStatus::Closed;
    env.storage().persistent().set(&channel_id, &channel);
}

pub fn keep_alive(env: &Env, channel_id: BytesN<32>) {
    assert!(
        env.storage().persistent().has(&channel_id),
        "not found: {}",
        ERR_NOT_FOUND
    );
    env.storage()
        .persistent()
        .extend_ttl(&channel_id, CHANNEL_TTL, CHANNEL_TTL);
}

pub fn payout(env: &Env, channel: &Channel, agent_balance: i128, server_balance: i128) {
    let token = token::Client::new(env, &channel.asset);
    if agent_balance > 0 {
        token.transfer(
            &env.current_contract_address(),
            &channel.agent,
            &agent_balance,
        );
    }
    if server_balance > 0 {
        token.transfer(
            &env.current_contract_address(),
            &channel.server,
            &server_balance,
        );
    }
}
