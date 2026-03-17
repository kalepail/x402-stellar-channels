#![no_std]

mod channel;
mod crypto;
mod dispute;
mod types;

use soroban_sdk::{contract, contractimpl};
pub use types::*;

#[cfg(test)]
pub use crypto::crypto_test;

#[contract]
pub struct ChannelContract;

#[contractimpl]
impl ChannelContract {}
