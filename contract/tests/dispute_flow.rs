#![cfg(test)]

use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, Address, BytesN, Env,
};
use x402_channel::{ChannelContract, ChannelContractClient, ChannelState};

fn gen_keypair(env: &Env) -> (SigningKey, BytesN<32>) {
    let sk = SigningKey::generate(&mut OsRng);
    let pk = BytesN::from_array(env, sk.verifying_key().as_bytes());
    (sk, pk)
}

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

struct TestCtx {
    env: Env,
    client: ChannelContractClient<'static>,
    channel_id: BytesN<32>,
    agent_sk: SigningKey,
    server_sk: SigningKey,
    agent: Address,
    server: Address,
    token_id: Address,
    deposit: i128,
}

impl TestCtx {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let (agent_sk, agent_pk) = gen_keypair(&env);
        let (server_sk, server_pk) = gen_keypair(&env);
        let agent = Address::generate(&env);
        let server = Address::generate(&env);
        let token_id = create_token(&env, &agent);
        let deposit: i128 = 100_0000;
        token::StellarAssetClient::new(&env, &token_id).mint(&agent, &1_000_0000);

        let contract_id = env.register(ChannelContract, ());
        // SAFETY: client borrows env but we store both in the same struct; the
        // lifetime is sound for the duration of the test.
        let client = ChannelContractClient::new(&env, &contract_id);
        let client: ChannelContractClient<'static> = unsafe { core::mem::transmute(client) };

        let nonce = BytesN::from_array(&env, &[42u8; 32]);
        let channel_id = client.open_channel(
            &agent, &agent_pk, &server, &server_pk, &token_id, &deposit, &nonce,
        );

        TestCtx {
            env,
            client,
            channel_id,
            agent_sk,
            server_sk,
            agent,
            server,
            token_id,
            deposit,
        }
    }
}

#[test]
fn test_initiate_dispute_sets_closing_status() {
    let ctx = TestCtx::new();
    let env = &ctx.env;

    let iteration: u64 = 1;
    let agent_balance: i128 = 90_0000;
    let server_balance: i128 = 10_0000;

    let agent_sig = sign_state(
        env,
        &ctx.agent_sk,
        &ctx.channel_id,
        iteration,
        agent_balance,
        server_balance,
    );
    let state = ChannelState {
        channel_id: ctx.channel_id.clone(),
        iteration,
        agent_balance,
        server_balance,
    };

    ctx.client
        .initiate_dispute(&ctx.channel_id, &state, &agent_sig, &true);

    // Channel is now Closing — close_channel (which requires Open) must fail.
    let server_sig = sign_state(
        env,
        &ctx.server_sk,
        &ctx.channel_id,
        iteration,
        agent_balance,
        server_balance,
    );
    let result = ctx
        .client
        .try_close_channel(&ctx.channel_id, &state, &agent_sig, &server_sig);
    assert!(
        result.is_err(),
        "close_channel should fail on a Closing channel"
    );
}

#[test]
fn test_resolve_dispute_with_higher_iteration_then_finalize() {
    let ctx = TestCtx::new();
    let env = &ctx.env;

    // Server initiates with stale iteration 1.
    let stale_iter: u64 = 1;
    let stale_agent_bal: i128 = 80_0000;
    let stale_server_bal: i128 = 20_0000;
    let server_sig_stale = sign_state(
        env,
        &ctx.server_sk,
        &ctx.channel_id,
        stale_iter,
        stale_agent_bal,
        stale_server_bal,
    );
    let stale_state = ChannelState {
        channel_id: ctx.channel_id.clone(),
        iteration: stale_iter,
        agent_balance: stale_agent_bal,
        server_balance: stale_server_bal,
    };
    ctx.client
        .initiate_dispute(&ctx.channel_id, &stale_state, &server_sig_stale, &false);

    // Agent resolves with a higher iteration (mutual, iteration 5).
    let final_iter: u64 = 5;
    let final_agent_bal: i128 = 97_0000;
    let final_server_bal: i128 = 3_0000;
    let agent_sig = sign_state(
        env,
        &ctx.agent_sk,
        &ctx.channel_id,
        final_iter,
        final_agent_bal,
        final_server_bal,
    );
    let server_sig = sign_state(
        env,
        &ctx.server_sk,
        &ctx.channel_id,
        final_iter,
        final_agent_bal,
        final_server_bal,
    );
    let final_state = ChannelState {
        channel_id: ctx.channel_id.clone(),
        iteration: final_iter,
        agent_balance: final_agent_bal,
        server_balance: final_server_bal,
    };
    ctx.client
        .resolve_dispute(&ctx.channel_id, &final_state, &agent_sig, &server_sig);

    // Advance ledger past observation window.
    env.ledger().with_mut(|l| l.sequence_number += 600);

    ctx.client.finalize_dispute(&ctx.channel_id);

    let token_client = token::Client::new(env, &ctx.token_id);
    assert_eq!(
        token_client.balance(&ctx.agent),
        1_000_0000 - ctx.deposit + final_agent_bal
    );
    assert_eq!(token_client.balance(&ctx.server), final_server_bal);
}

#[test]
fn test_finalize_before_window_panics() {
    let ctx = TestCtx::new();
    let env = &ctx.env;

    let iteration: u64 = 1;
    let agent_balance: i128 = 90_0000;
    let server_balance: i128 = 10_0000;
    let agent_sig = sign_state(
        env,
        &ctx.agent_sk,
        &ctx.channel_id,
        iteration,
        agent_balance,
        server_balance,
    );
    let state = ChannelState {
        channel_id: ctx.channel_id.clone(),
        iteration,
        agent_balance,
        server_balance,
    };
    ctx.client
        .initiate_dispute(&ctx.channel_id, &state, &agent_sig, &true);

    // Window not yet expired — finalize should fail.
    let result = ctx.client.try_finalize_dispute(&ctx.channel_id);
    assert!(
        result.is_err(),
        "finalize_dispute should fail while window is active"
    );
}

#[test]
fn test_dispute_on_closing_channel_fails() {
    let ctx = TestCtx::new();
    let env = &ctx.env;

    let iteration: u64 = 1;
    let agent_balance: i128 = 90_0000;
    let server_balance: i128 = 10_0000;

    let agent_sig = sign_state(
        env,
        &ctx.agent_sk,
        &ctx.channel_id,
        iteration,
        agent_balance,
        server_balance,
    );
    let state = ChannelState {
        channel_id: ctx.channel_id.clone(),
        iteration,
        agent_balance,
        server_balance,
    };

    ctx.client
        .initiate_dispute(&ctx.channel_id, &state, &agent_sig, &true);

    // Second initiate_dispute on the same (now Closing) channel should fail
    let iter2: u64 = 2;
    let ab2: i128 = 85_0000;
    let sb2: i128 = 15_0000;
    let agent_sig2 = sign_state(env, &ctx.agent_sk, &ctx.channel_id, iter2, ab2, sb2);
    let state2 = ChannelState {
        channel_id: ctx.channel_id.clone(),
        iteration: iter2,
        agent_balance: ab2,
        server_balance: sb2,
    };
    let result = ctx
        .client
        .try_initiate_dispute(&ctx.channel_id, &state2, &agent_sig2, &true);
    assert!(
        result.is_err(),
        "initiate_dispute should fail on a Closing channel"
    );
}

#[test]
fn test_resolve_with_same_iteration_fails() {
    let ctx = TestCtx::new();
    let env = &ctx.env;

    let iteration: u64 = 3;
    let agent_balance: i128 = 90_0000;
    let server_balance: i128 = 10_0000;

    let agent_sig = sign_state(
        env,
        &ctx.agent_sk,
        &ctx.channel_id,
        iteration,
        agent_balance,
        server_balance,
    );
    let state = ChannelState {
        channel_id: ctx.channel_id.clone(),
        iteration,
        agent_balance,
        server_balance,
    };
    ctx.client
        .initiate_dispute(&ctx.channel_id, &state, &agent_sig, &true);

    // Try to resolve with the same iteration — should fail (must be strictly higher)
    let server_sig = sign_state(
        env,
        &ctx.server_sk,
        &ctx.channel_id,
        iteration,
        agent_balance,
        server_balance,
    );
    let result = ctx
        .client
        .try_resolve_dispute(&ctx.channel_id, &state, &agent_sig, &server_sig);
    assert!(
        result.is_err(),
        "resolve_dispute should fail with same iteration as dispute state"
    );
}

#[test]
fn test_resolve_after_window_expired_fails() {
    let ctx = TestCtx::new();
    let env = &ctx.env;

    let iteration: u64 = 1;
    let agent_balance: i128 = 90_0000;
    let server_balance: i128 = 10_0000;

    let agent_sig = sign_state(
        env,
        &ctx.agent_sk,
        &ctx.channel_id,
        iteration,
        agent_balance,
        server_balance,
    );
    let state = ChannelState {
        channel_id: ctx.channel_id.clone(),
        iteration,
        agent_balance,
        server_balance,
    };
    ctx.client
        .initiate_dispute(&ctx.channel_id, &state, &agent_sig, &true);

    // Advance past the observation window
    env.ledger().with_mut(|l| l.sequence_number += 600);

    // Try to resolve — window has expired
    let iter2: u64 = 5;
    let ab2: i128 = 85_0000;
    let sb2: i128 = 15_0000;
    let agent_sig2 = sign_state(env, &ctx.agent_sk, &ctx.channel_id, iter2, ab2, sb2);
    let server_sig2 = sign_state(env, &ctx.server_sk, &ctx.channel_id, iter2, ab2, sb2);
    let state2 = ChannelState {
        channel_id: ctx.channel_id.clone(),
        iteration: iter2,
        agent_balance: ab2,
        server_balance: sb2,
    };
    let result =
        ctx.client
            .try_resolve_dispute(&ctx.channel_id, &state2, &agent_sig2, &server_sig2);
    assert!(
        result.is_err(),
        "resolve_dispute should fail after observation window expired"
    );
}

#[test]
fn test_resolve_requires_both_sigs() {
    let ctx = TestCtx::new();
    let env = &ctx.env;

    let iteration: u64 = 1;
    let agent_balance: i128 = 90_0000;
    let server_balance: i128 = 10_0000;
    let agent_sig = sign_state(
        env,
        &ctx.agent_sk,
        &ctx.channel_id,
        iteration,
        agent_balance,
        server_balance,
    );
    let state = ChannelState {
        channel_id: ctx.channel_id.clone(),
        iteration,
        agent_balance,
        server_balance,
    };
    ctx.client
        .initiate_dispute(&ctx.channel_id, &state, &agent_sig, &true);

    // Resolve with iteration 2, but server sig is actually an agent sig (wrong key).
    let iter2: u64 = 2;
    let ab2: i128 = 85_0000;
    let sb2: i128 = 15_0000;
    let agent_sig2 = sign_state(env, &ctx.agent_sk, &ctx.channel_id, iter2, ab2, sb2);
    // Wrong: agent signs twice instead of server signing.
    let bad_server_sig = sign_state(env, &ctx.agent_sk, &ctx.channel_id, iter2, ab2, sb2);
    let state2 = ChannelState {
        channel_id: ctx.channel_id.clone(),
        iteration: iter2,
        agent_balance: ab2,
        server_balance: sb2,
    };
    let result =
        ctx.client
            .try_resolve_dispute(&ctx.channel_id, &state2, &agent_sig2, &bad_server_sig);
    assert!(
        result.is_err(),
        "resolve_dispute should fail with wrong server sig"
    );
}
