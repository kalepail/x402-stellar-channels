use soroban_sdk::{contracttype, Address, BytesN};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ChannelStatus {
    Open,
    Closing,
    Closed,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ChannelState {
    pub channel_id: BytesN<32>,
    pub iteration: u64,
    pub agent_balance: i128,
    pub server_balance: i128,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Channel {
    /// sha256(agent_pubkey_bytes || nonce)
    pub id: BytesN<32>,
    pub agent: Address,
    /// Raw ed25519 public key (32 bytes) — stored for signature verification
    pub agent_pubkey: BytesN<32>,
    pub server: Address,
    pub server_pubkey: BytesN<32>,
    pub asset: Address,
    pub deposit: i128,
    pub iteration: u64,          // latest agreed iteration (starts at 0)
    pub agent_balance: i128,
    pub server_balance: i128,
    pub status: ChannelStatus,
    /// Ledger sequence; dispute window closes *after* this ledger (exclusive)
    pub observation_end: Option<u32>,
}

/// Dispute state stored separately under a derived key to avoid nested
/// contracttype composition issues.
#[contracttype]
#[derive(Clone, Debug)]
pub struct DisputeState {
    pub channel_id: BytesN<32>,
    pub iteration: u64,
    pub agent_balance: i128,
    pub server_balance: i128,
}

/// ~42 min observation window at ~5s/ledger
pub const OBSERVATION_WINDOW: u32 = 500;
/// ~1 year of ledgers for storage TTL
pub const CHANNEL_TTL: u32 = 6_307_200;

pub const ERR_NOT_FOUND: u32 = 1;
pub const ERR_NOT_OPEN: u32 = 2;
pub const ERR_NOT_CLOSING: u32 = 3;
pub const ERR_ALREADY_CLOSED: u32 = 4;
pub const ERR_BAD_ITERATION: u32 = 5;
pub const ERR_BAD_BALANCES: u32 = 6;
pub const ERR_WINDOW_ACTIVE: u32 = 7;
pub const ERR_WINDOW_EXPIRED: u32 = 8;
pub const ERR_BAD_SIG: u32 = 9;
