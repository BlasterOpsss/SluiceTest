//! Orca Whirlpools CPI wrappers (hand-encoded; no external Orca crate).
//!
//! Account orders follow the Whirlpool program IDL (classic Token-program
//! instructions). The vault PDA is the position owner/authority, so liquidity
//! calls are signed with the vault seeds. Every caller in lib.rs has already
//! checked: agent authority, pause flag, daily cap, pool allowlist, and that
//! token accounts are owned by the vault.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
};

use crate::{OrcaClose, OrcaCollect, OrcaLiquidity, OrcaOpen};

pub const WHIRLPOOL_ID: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

const OPEN_POSITION: [u8; 8] = [135, 128, 47, 77, 15, 152, 240, 49];
pub const INCREASE_LIQUIDITY: [u8; 8] = [46, 156, 243, 118, 13, 205, 251, 178];
pub const DECREASE_LIQUIDITY: [u8; 8] = [160, 38, 208, 111, 104, 91, 44, 1];
const COLLECT_FEES: [u8; 8] = [164, 152, 207, 99, 30, 186, 19, 182];
const CLOSE_POSITION: [u8; 8] = [123, 134, 81, 0, 49, 68, 98, 98];

/// Agent pays rent and signs the new position mint; the vault PDA becomes the owner.
pub fn open_position<'info>(
    a: &OrcaOpen<'info>,
    position_bump: u8,
    tick_lower: i32,
    tick_upper: i32,
) -> Result<()> {
    let mut data = Vec::with_capacity(17);
    data.extend_from_slice(&OPEN_POSITION);
    data.push(position_bump);
    data.extend_from_slice(&tick_lower.to_le_bytes());
    data.extend_from_slice(&tick_upper.to_le_bytes());

    let ix = Instruction {
        program_id: WHIRLPOOL_ID,
        accounts: vec![
            AccountMeta::new(a.agent.key(), true),
            AccountMeta::new_readonly(a.vault.key(), false),
            AccountMeta::new(a.position.key(), false),
            AccountMeta::new(a.position_mint.key(), true),
            AccountMeta::new(a.position_token_account.key(), false),
            AccountMeta::new_readonly(a.whirlpool.key(), false),
            AccountMeta::new_readonly(a.token_program.key(), false),
            AccountMeta::new_readonly(a.system_program.key(), false),
            AccountMeta::new_readonly(a.rent.key(), false),
            AccountMeta::new_readonly(a.associated_token_program.key(), false),
        ],
        data,
    };
    invoke(
        &ix,
        &[
            a.agent.to_account_info(),
            a.vault.to_account_info(),
            a.position.to_account_info(),
            a.position_mint.to_account_info(),
            a.position_token_account.to_account_info(),
            a.whirlpool.to_account_info(),
            a.token_program.to_account_info(),
            a.system_program.to_account_info(),
            a.rent.to_account_info(),
            a.associated_token_program.to_account_info(),
            a.whirlpool_program.to_account_info(),
        ],
    )?;
    Ok(())
}

/// increase_liquidity / decrease_liquidity share the same account order.
/// `amount_a` / `amount_b` are token_max for increase and token_min for decrease.
pub fn liquidity<'info>(
    disc: [u8; 8],
    liquidity_amount: u128,
    amount_a: u64,
    amount_b: u64,
    a: &OrcaLiquidity<'info>,
) -> Result<()> {
    let mut data = Vec::with_capacity(40);
    data.extend_from_slice(&disc);
    data.extend_from_slice(&liquidity_amount.to_le_bytes());
    data.extend_from_slice(&amount_a.to_le_bytes());
    data.extend_from_slice(&amount_b.to_le_bytes());

    let ix = Instruction {
        program_id: WHIRLPOOL_ID,
        accounts: vec![
            AccountMeta::new(a.whirlpool.key(), false),
            AccountMeta::new_readonly(a.token_program.key(), false),
            AccountMeta::new_readonly(a.vault.key(), true),
            AccountMeta::new(a.position.key(), false),
            AccountMeta::new_readonly(a.position_token_account.key(), false),
            AccountMeta::new(a.token_owner_account_a.key(), false),
            AccountMeta::new(a.token_owner_account_b.key(), false),
            AccountMeta::new(a.token_vault_a.key(), false),
            AccountMeta::new(a.token_vault_b.key(), false),
            AccountMeta::new(a.tick_array_lower.key(), false),
            AccountMeta::new(a.tick_array_upper.key(), false),
        ],
        data,
    };
    let owner = a.vault.owner;
    let seeds: &[&[u8]] = &[b"vault", owner.as_ref(), &[a.vault.bump]];
    invoke_signed(
        &ix,
        &[
            a.whirlpool.to_account_info(),
            a.token_program.to_account_info(),
            a.vault.to_account_info(),
            a.position.to_account_info(),
            a.position_token_account.to_account_info(),
            a.token_owner_account_a.to_account_info(),
            a.token_owner_account_b.to_account_info(),
            a.token_vault_a.to_account_info(),
            a.token_vault_b.to_account_info(),
            a.tick_array_lower.to_account_info(),
            a.tick_array_upper.to_account_info(),
            a.whirlpool_program.to_account_info(),
        ],
        &[seeds],
    )?;
    Ok(())
}

/// Position must have zero liquidity (decrease first). Rent refund goes to the agent.
pub fn close_position<'info>(a: &OrcaClose<'info>) -> Result<()> {
    let ix = Instruction {
        program_id: WHIRLPOOL_ID,
        accounts: vec![
            AccountMeta::new_readonly(a.vault.key(), true),
            AccountMeta::new(a.agent.key(), false),
            AccountMeta::new(a.position.key(), false),
            AccountMeta::new(a.position_mint.key(), false),
            AccountMeta::new(a.position_token_account.key(), false),
            AccountMeta::new_readonly(a.token_program.key(), false),
        ],
        data: CLOSE_POSITION.to_vec(),
    };
    let owner = a.vault.owner;
    let seeds: &[&[u8]] = &[b"vault", owner.as_ref(), &[a.vault.bump]];
    invoke_signed(
        &ix,
        &[
            a.vault.to_account_info(),
            a.agent.to_account_info(),
            a.position.to_account_info(),
            a.position_mint.to_account_info(),
            a.position_token_account.to_account_info(),
            a.token_program.to_account_info(),
            a.whirlpool_program.to_account_info(),
        ],
        &[seeds],
    )?;
    Ok(())
}

/// Collect accrued fees into the vault's own token accounts. Required before
/// closing a position that has earned fees.
pub fn collect_fees<'info>(a: &OrcaCollect<'info>) -> Result<()> {
    let ix = Instruction {
        program_id: WHIRLPOOL_ID,
        accounts: vec![
            AccountMeta::new(a.whirlpool.key(), false),
            AccountMeta::new_readonly(a.vault.key(), true),
            AccountMeta::new(a.position.key(), false),
            AccountMeta::new_readonly(a.position_token_account.key(), false),
            AccountMeta::new(a.token_owner_account_a.key(), false),
            AccountMeta::new(a.token_vault_a.key(), false),
            AccountMeta::new(a.token_owner_account_b.key(), false),
            AccountMeta::new(a.token_vault_b.key(), false),
            AccountMeta::new_readonly(a.token_program.key(), false),
        ],
        data: COLLECT_FEES.to_vec(),
    };
    let owner = a.vault.owner;
    let seeds: &[&[u8]] = &[b"vault", owner.as_ref(), &[a.vault.bump]];
    invoke_signed(
        &ix,
        &[
            a.whirlpool.to_account_info(),
            a.vault.to_account_info(),
            a.position.to_account_info(),
            a.position_token_account.to_account_info(),
            a.token_owner_account_a.to_account_info(),
            a.token_vault_a.to_account_info(),
            a.token_owner_account_b.to_account_info(),
            a.token_vault_b.to_account_info(),
            a.token_program.to_account_info(),
            a.whirlpool_program.to_account_info(),
        ],
        &[seeds],
    )?;
    Ok(())
}
