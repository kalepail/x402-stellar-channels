use crate::types::*;
use soroban_sdk::{BytesN, Env};

pub fn initiate_dispute(
    _env: &Env,
    _channel_id: BytesN<32>,
    _state: ChannelState,
    _sig: BytesN<64>,
    _is_agent: bool,
) {
    panic!("not implemented");
}

pub fn resolve_dispute(
    _env: &Env,
    _channel_id: BytesN<32>,
    _state: ChannelState,
    _agent_sig: BytesN<64>,
    _server_sig: BytesN<64>,
) {
    panic!("not implemented");
}

pub fn finalize_dispute(_env: &Env, _channel_id: BytesN<32>) {
    panic!("not implemented");
}
