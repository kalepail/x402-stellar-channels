#![cfg(test)]

use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use soroban_sdk::{testutils::Address as _, token, Address, BytesN, Env};
use x402_channel::{ChannelContract, ChannelContractClient, ChannelState};

/// Generate an ed25519 keypair and return (signing_key, pubkey_bytes_32).
fn gen_keypair(env: &Env) -> (SigningKey, BytesN<32>) {
    let sk = SigningKey::generate(&mut OsRng);
    let pk = BytesN::from_array(env, sk.verifying_key().as_bytes());
    (sk, pk)
}

/// Sign the canonical state message with ed25519.
fn sign_state(
    env: &Env,
    sk: &SigningKey,
    channel_id: &BytesN<32>,
    iteration: u64,
    agent_balance: i128,
    server_balance: i128,
) -> BytesN<64> {
    let msg = x402_channel::crypto_test::state_msg_bytes(
        env,
        channel_id,
        iteration,
        agent_balance,
        server_balance,
    );
    let sig = sk.sign(&msg);
    BytesN::from_array(env, &sig.to_bytes())
}

fn create_token(env: &Env, admin: &Address) -> Address {
    env.register_stellar_asset_contract_v2(admin.clone())
        .address()
}

#[test]
fn test_open_channel_creates_channel() {
    let env = Env::default();
    env.mock_all_auths();

    let (_agent_sk, agent_pk) = gen_keypair(&env);
    let (_server_sk, server_pk) = gen_keypair(&env);
    let agent = Address::generate(&env);
    let server = Address::generate(&env);
    let token_id = create_token(&env, &agent);
    token::StellarAssetClient::new(&env, &token_id).mint(&agent, &1_000_0000);

    let contract_id = env.register(ChannelContract, ());
    let client = ChannelContractClient::new(&env, &contract_id);

    let deposit: i128 = 100_0000;
    let nonce = BytesN::from_array(&env, &[1u8; 32]);

    let channel_id = client.open_channel(
        &agent, &agent_pk, &server, &server_pk, &token_id, &deposit, &nonce,
    );

    // Different nonce → different channel_id
    let nonce2 = BytesN::from_array(&env, &[2u8; 32]);
    let channel_id2 = client.open_channel(
        &agent, &agent_pk, &server, &server_pk, &token_id, &deposit, &nonce2,
    );
    assert_ne!(channel_id, channel_id2);
}

#[test]
fn test_close_channel_distributes_funds() {
    let env = Env::default();
    env.mock_all_auths();

    let (agent_sk, agent_pk) = gen_keypair(&env);
    let (server_sk, server_pk) = gen_keypair(&env);
    let agent = Address::generate(&env);
    let server = Address::generate(&env);
    let token_id = create_token(&env, &agent);
    token::StellarAssetClient::new(&env, &token_id).mint(&agent, &1_000_0000);

    let contract_id = env.register(ChannelContract, ());
    let client = ChannelContractClient::new(&env, &contract_id);

    let deposit: i128 = 100_0000;
    let nonce = BytesN::from_array(&env, &[1u8; 32]);
    let channel_id = client.open_channel(
        &agent, &agent_pk, &server, &server_pk, &token_id, &deposit, &nonce,
    );

    let agent_balance: i128 = 97_0000;
    let server_balance: i128 = 3_0000;
    let iteration: u64 = 3;

    let agent_sig = sign_state(
        &env,
        &agent_sk,
        &channel_id,
        iteration,
        agent_balance,
        server_balance,
    );
    let server_sig = sign_state(
        &env,
        &server_sk,
        &channel_id,
        iteration,
        agent_balance,
        server_balance,
    );

    let state = ChannelState {
        channel_id: channel_id.clone(),
        iteration,
        agent_balance,
        server_balance,
    };
    client.close_channel(&channel_id, &state, &agent_sig, &server_sig);

    let token_client = token::Client::new(&env, &token_id);
    assert_eq!(
        token_client.balance(&agent),
        1_000_0000 - deposit + agent_balance
    );
    assert_eq!(token_client.balance(&server), server_balance);
}

#[test]
fn test_close_already_closed_channel_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let (agent_sk, agent_pk) = gen_keypair(&env);
    let (server_sk, server_pk) = gen_keypair(&env);
    let agent = Address::generate(&env);
    let server = Address::generate(&env);
    let token_id = create_token(&env, &agent);
    token::StellarAssetClient::new(&env, &token_id).mint(&agent, &1_000_0000);

    let contract_id = env.register(ChannelContract, ());
    let client = ChannelContractClient::new(&env, &contract_id);

    let deposit: i128 = 100_0000;
    let nonce = BytesN::from_array(&env, &[1u8; 32]);
    let channel_id = client.open_channel(
        &agent, &agent_pk, &server, &server_pk, &token_id, &deposit, &nonce,
    );

    let iteration: u64 = 1;
    let agent_balance: i128 = 97_0000;
    let server_balance: i128 = 3_0000;
    let agent_sig = sign_state(
        &env,
        &agent_sk,
        &channel_id,
        iteration,
        agent_balance,
        server_balance,
    );
    let server_sig = sign_state(
        &env,
        &server_sk,
        &channel_id,
        iteration,
        agent_balance,
        server_balance,
    );
    let state = ChannelState {
        channel_id: channel_id.clone(),
        iteration,
        agent_balance,
        server_balance,
    };

    client.close_channel(&channel_id, &state, &agent_sig, &server_sig);

    // Second close should fail — channel is already Closed
    let result = client.try_close_channel(&channel_id, &state, &agent_sig, &server_sig);
    assert!(
        result.is_err(),
        "close_channel should fail on an already-closed channel"
    );
}

#[test]
fn test_close_with_bad_balances_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let (agent_sk, agent_pk) = gen_keypair(&env);
    let (server_sk, server_pk) = gen_keypair(&env);
    let agent = Address::generate(&env);
    let server = Address::generate(&env);
    let token_id = create_token(&env, &agent);
    token::StellarAssetClient::new(&env, &token_id).mint(&agent, &1_000_0000);

    let contract_id = env.register(ChannelContract, ());
    let client = ChannelContractClient::new(&env, &contract_id);

    let deposit: i128 = 100_0000;
    let nonce = BytesN::from_array(&env, &[1u8; 32]);
    let channel_id = client.open_channel(
        &agent, &agent_pk, &server, &server_pk, &token_id, &deposit, &nonce,
    );

    // Balances don't sum to deposit (50 + 40 != 100)
    let agent_balance: i128 = 50_0000;
    let server_balance: i128 = 40_0000;
    let agent_sig = sign_state(
        &env,
        &agent_sk,
        &channel_id,
        1,
        agent_balance,
        server_balance,
    );
    let server_sig = sign_state(
        &env,
        &server_sk,
        &channel_id,
        1,
        agent_balance,
        server_balance,
    );
    let state = ChannelState {
        channel_id: channel_id.clone(),
        iteration: 1,
        agent_balance,
        server_balance,
    };

    let result = client.try_close_channel(&channel_id, &state, &agent_sig, &server_sig);
    assert!(
        result.is_err(),
        "close_channel should fail when balances don't sum to deposit"
    );
}

#[test]
fn test_close_with_wrong_agent_sig_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let (_agent_sk, agent_pk) = gen_keypair(&env);
    let (server_sk, server_pk) = gen_keypair(&env);
    let (imposter_sk, _) = gen_keypair(&env);
    let agent = Address::generate(&env);
    let server = Address::generate(&env);
    let token_id = create_token(&env, &agent);
    token::StellarAssetClient::new(&env, &token_id).mint(&agent, &1_000_0000);

    let contract_id = env.register(ChannelContract, ());
    let client = ChannelContractClient::new(&env, &contract_id);

    let deposit: i128 = 100_0000;
    let nonce = BytesN::from_array(&env, &[1u8; 32]);
    let channel_id = client.open_channel(
        &agent, &agent_pk, &server, &server_pk, &token_id, &deposit, &nonce,
    );

    let agent_balance: i128 = 97_0000;
    let server_balance: i128 = 3_0000;
    // Imposter signs instead of agent
    let bad_agent_sig = sign_state(
        &env,
        &imposter_sk,
        &channel_id,
        1,
        agent_balance,
        server_balance,
    );
    let server_sig = sign_state(
        &env,
        &server_sk,
        &channel_id,
        1,
        agent_balance,
        server_balance,
    );
    let state = ChannelState {
        channel_id: channel_id.clone(),
        iteration: 1,
        agent_balance,
        server_balance,
    };

    let result = client.try_close_channel(&channel_id, &state, &bad_agent_sig, &server_sig);
    assert!(
        result.is_err(),
        "close_channel should fail with wrong agent signature"
    );
}

#[test]
fn test_keep_alive_does_not_panic() {
    let env = Env::default();
    env.mock_all_auths();

    let (_, agent_pk) = gen_keypair(&env);
    let (_, server_pk) = gen_keypair(&env);
    let agent = Address::generate(&env);
    let server = Address::generate(&env);
    let token_id = create_token(&env, &agent);
    token::StellarAssetClient::new(&env, &token_id).mint(&agent, &1_000_0000);

    let contract_id = env.register(ChannelContract, ());
    let client = ChannelContractClient::new(&env, &contract_id);
    let nonce = BytesN::from_array(&env, &[1u8; 32]);
    let channel_id = client.open_channel(
        &agent, &agent_pk, &server, &server_pk, &token_id, &100_0000, &nonce,
    );
    client.keep_alive(&channel_id);
}

#[test]
fn test_keep_alive_nonexistent_channel_fails() {
    let env = Env::default();
    let contract_id = env.register(ChannelContract, ());
    let client = ChannelContractClient::new(&env, &contract_id);

    let fake_id = BytesN::from_array(&env, &[0xffu8; 32]);
    let result = client.try_keep_alive(&fake_id);
    assert!(
        result.is_err(),
        "keep_alive should fail for nonexistent channel"
    );
}
