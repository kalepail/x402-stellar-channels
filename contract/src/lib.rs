#![no_std]

mod channel;
mod crypto;
mod dispute;
mod types;

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env};
pub use types::*;

#[cfg(any(test, feature = "testutils"))]
pub use crypto::crypto_test;

#[contract]
pub struct ChannelContract;

#[contractimpl]
impl ChannelContract {
    pub fn open_channel(
        env: Env,
        agent: Address,
        agent_pubkey: BytesN<32>,
        server: Address,
        server_pubkey: BytesN<32>,
        asset: Address,
        deposit: i128,
        nonce: BytesN<32>,
    ) -> BytesN<32> {
        channel::open_channel(
            &env,
            agent,
            agent_pubkey,
            server,
            server_pubkey,
            asset,
            deposit,
            nonce,
        )
    }

    pub fn close_channel(
        env: Env,
        channel_id: BytesN<32>,
        state: ChannelState,
        agent_sig: BytesN<64>,
        server_sig: BytesN<64>,
    ) {
        channel::close_channel(&env, channel_id, state, agent_sig, server_sig)
    }

    pub fn keep_alive(env: Env, channel_id: BytesN<32>) {
        channel::keep_alive(&env, channel_id)
    }

    pub fn initiate_dispute(
        env: Env,
        channel_id: BytesN<32>,
        state: ChannelState,
        sig: BytesN<64>,
        is_agent: bool,
    ) {
        dispute::initiate_dispute(&env, channel_id, state, sig, is_agent)
    }

    pub fn resolve_dispute(
        env: Env,
        channel_id: BytesN<32>,
        state: ChannelState,
        agent_sig: BytesN<64>,
        server_sig: BytesN<64>,
    ) {
        dispute::resolve_dispute(&env, channel_id, state, agent_sig, server_sig)
    }

    pub fn finalize_dispute(env: Env, channel_id: BytesN<32>) {
        dispute::finalize_dispute(&env, channel_id)
    }
}
