//! On-chain Pyth price check for liquidity deposits.
//!
//! The owner configures, per pool, which two Pyth feeds describe the pool's
//! tokens (see `set_pool_oracle`). Before the agent adds liquidity, the pool's
//! current price must be within `max_deviation_bps` of the price implied by the
//! two Pyth USD feeds. Pyth accounts are parsed by hand (no extra crates) and
//! must be owned by the Pyth Receiver program with Full verification.
//!
//! Protocol for `orca_increase_liquidity` remaining accounts:
//!   [0] pool_oracle PDA  (always required; empty = owner has not configured one)
//!   [1] price_a  [2] price_b  [3] mint_a  [4] mint_b   (required if configured)

use anchor_lang::prelude::*;

use crate::adapters::orca::WHIRLPOOL_ID;
use crate::{PoolOracle, VaultError};

pub const PYTH_RECEIVER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const PRICE_UPDATE_V2: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PythPrice {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
}

fn rd_i64(d: &[u8], at: usize) -> Option<i64> {
    Some(i64::from_le_bytes(d.get(at..at + 8)?.try_into().ok()?))
}
fn rd_u64(d: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(d.get(at..at + 8)?.try_into().ok()?))
}
fn rd_i32(d: &[u8], at: usize) -> Option<i32> {
    Some(i32::from_le_bytes(d.get(at..at + 4)?.try_into().ok()?))
}
fn rd_u128(d: &[u8], at: usize) -> Option<u128> {
    Some(u128::from_le_bytes(d.get(at..at + 16)?.try_into().ok()?))
}

/// Parse a PriceUpdateV2 account. Only `Full` verification is accepted.
/// Layout: disc(8) | write_authority(32) | verification tag(1) | price_message...
pub fn parse_price_update(d: &[u8]) -> Option<PythPrice> {
    if d.len() < 41 || d[..8] != PRICE_UPDATE_V2 {
        return None;
    }
    if d[40] != 1 {
        return None; // 0 = Partial{num_signatures}, 1 = Full
    }
    let s = 41;
    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(d.get(s..s + 32)?);
    Some(PythPrice {
        feed_id,
        price: rd_i64(d, s + 32)?,
        conf: rd_u64(d, s + 40)?,
        exponent: rd_i32(d, s + 48)?,
        publish_time: rd_i64(d, s + 52)?,
    })
}

/// Pool price (token B per token A, human units) scaled by 1e9, from the
/// Whirlpool Q64.64 sqrt price and the two mint decimals.
pub fn pool_price_e9(sqrt_price: u128, dec_a: u8, dec_b: u8) -> Option<u128> {
    let s = sqrt_price >> 32;
    let q64 = s.checked_mul(s)?;
    let (mul, div) = if dec_a >= dec_b {
        (10u128.checked_pow((dec_a - dec_b) as u32)?, 1u128)
    } else {
        (1u128, 10u128.checked_pow((dec_b - dec_a) as u32)?)
    };
    let scaled = q64.checked_mul(mul)?.checked_mul(1_000_000_000)?;
    Some((scaled >> 64) / div)
}

/// Price of token A in token B implied by two USD feeds, scaled by 1e9.
pub fn oracle_price_e9(a: &PythPrice, b: &PythPrice) -> Option<u128> {
    if a.price <= 0 || b.price <= 0 {
        return None;
    }
    let pa = a.price as u128;
    let pb = b.price as u128;
    let e = a.exponent.checked_sub(b.exponent)?;
    let mut num = pa.checked_mul(1_000_000_000)?;
    let mut den = pb;
    if e >= 0 {
        num = num.checked_mul(10u128.checked_pow(e as u32)?)?;
    } else {
        den = den.checked_mul(10u128.checked_pow(e.unsigned_abs())?)?;
    }
    Some(num / den)
}

pub fn deviation_bps(pool: u128, oracle: u128) -> Option<u128> {
    if oracle == 0 {
        return None;
    }
    let diff = if pool > oracle { pool - oracle } else { oracle - pool };
    Some(diff.checked_mul(10_000)? / oracle)
}

fn conf_bps(p: &PythPrice) -> Option<u128> {
    (p.conf as u128).checked_mul(10_000)?.checked_div(p.price as u128)
}

pub fn check(program_id: &Pubkey, vault: &Pubkey, pool: &AccountInfo, extra: &[AccountInfo]) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(
        &[b"oracle", vault.as_ref(), pool.key.as_ref()],
        program_id,
    );
    let cfg_info = extra.first().ok_or(VaultError::OracleAccountsMissing)?;
    require_keys_eq!(*cfg_info.key, expected, VaultError::OracleBadAccount);

    // Owner has not configured an oracle for this pool: nothing to enforce.
    if cfg_info.data_is_empty() {
        return Ok(());
    }
    require_keys_eq!(*cfg_info.owner, *program_id, VaultError::OracleBadAccount);
    let cfg = {
        let data = cfg_info.try_borrow_data()?;
        PoolOracle::try_deserialize(&mut &data[..])?
    };
    require!(extra.len() >= 5, VaultError::OracleAccountsMissing);
    let (price_a, price_b, mint_a, mint_b) = (&extra[1], &extra[2], &extra[3], &extra[4]);

    // Pool state
    require_keys_eq!(*pool.owner, WHIRLPOOL_ID, VaultError::OracleBadAccount);
    let (sqrt_price, pool_mint_a, pool_mint_b) = {
        let d = pool.try_borrow_data()?;
        require!(d.len() >= 245, VaultError::OracleBadAccount);
        (
            rd_u128(&d, 65).ok_or(VaultError::OracleBadAccount)?,
            Pubkey::try_from(&d[101..133]).map_err(|_| VaultError::OracleBadAccount)?,
            Pubkey::try_from(&d[181..213]).map_err(|_| VaultError::OracleBadAccount)?,
        )
    };

    // Mint decimals (mints must be the pool's own mints)
    let dec = |info: &AccountInfo, want: &Pubkey| -> Result<u8> {
        require_keys_eq!(*info.key, *want, VaultError::OracleBadAccount);
        require_keys_eq!(*info.owner, anchor_spl::token::ID, VaultError::OracleBadAccount);
        let d = info.try_borrow_data()?;
        Ok(*d.get(44).ok_or(VaultError::OracleBadAccount)?)
    };
    let dec_a = dec(mint_a, &pool_mint_a)?;
    let dec_b = dec(mint_b, &pool_mint_b)?;

    // Pyth prices
    let load = |info: &AccountInfo, feed: &[u8; 32]| -> Result<PythPrice> {
        require_keys_eq!(*info.owner, PYTH_RECEIVER, VaultError::OracleBadAccount);
        let d = info.try_borrow_data()?;
        let p = parse_price_update(&d).ok_or(VaultError::OracleBadAccount)?;
        require!(p.feed_id == *feed, VaultError::OracleBadAccount);
        Ok(p)
    };
    let pa = load(price_a, &cfg.feed_id_a)?;
    let pb = load(price_b, &cfg.feed_id_b)?;

    let now = Clock::get()?.unix_timestamp;
    for p in [&pa, &pb] {
        require!(
            now.saturating_sub(p.publish_time) <= cfg.max_age_secs as i64
                && p.publish_time <= now.saturating_add(60),
            VaultError::OracleStale
        );
    }

    // Wide confidence intervals count against the allowed deviation.
    let conf_total = conf_bps(&pa)
        .and_then(|a| conf_bps(&pb).map(|b| a + b))
        .ok_or(VaultError::OracleMath)?;
    require!(conf_total <= cfg.max_deviation_bps as u128, VaultError::OracleDeviation);

    let pool_p = pool_price_e9(sqrt_price, dec_a, dec_b).ok_or(VaultError::OracleMath)?;
    let oracle_p = oracle_price_e9(&pa, &pb).ok_or(VaultError::OracleMath)?;
    let dev = deviation_bps(pool_p, oracle_p).ok_or(VaultError::OracleMath)?;
    require!(dev <= cfg.max_deviation_bps as u128, VaultError::OracleDeviation);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(price: i64, exponent: i32) -> PythPrice {
        PythPrice { feed_id: [7; 32], price, conf: 0, exponent, publish_time: 0 }
    }

    #[test]
    fn pool_price_equal_decimals() {
        assert_eq!(pool_price_e9(1u128 << 64, 6, 6), Some(1_000_000_000));
    }

    #[test]
    fn pool_price_sol_usdc() {
        // raw price 0.15 (150 USDC per SOL with 9 vs 6 decimals)
        let p = pool_price_e9(7_144_393_258_922_745_856, 9, 6).unwrap();
        assert!(deviation_bps(p, 150_000_000_000).unwrap() <= 1);
    }

    #[test]
    fn oracle_ratio() {
        assert_eq!(oracle_price_e9(&feed(15_000_000_000, -8), &feed(15_000_000_000, -8)), Some(1_000_000_000));
        // 150 / 60000 = 0.0025
        assert_eq!(oracle_price_e9(&feed(15_000_000_000, -8), &feed(6_000_000_000_000, -8)), Some(2_500_000));
        // different exponents: 150 (exp -8) vs 150 (exp -6)
        assert_eq!(oracle_price_e9(&feed(15_000_000_000, -8), &feed(150_000_000, -6)), Some(1_000_000_000));
        assert_eq!(oracle_price_e9(&feed(0, -8), &feed(1, -8)), None);
    }

    #[test]
    fn deviation() {
        assert_eq!(deviation_bps(1_000_000_000, 1_000_000_000), Some(0));
        assert_eq!(deviation_bps(1_010_000_000, 1_000_000_000), Some(100));
        assert_eq!(deviation_bps(990_000_000, 1_000_000_000), Some(100));
        assert_eq!(deviation_bps(1, 0), None);
    }

    #[test]
    fn parse_full_and_partial() {
        let mut d = Vec::new();
        d.extend_from_slice(&PRICE_UPDATE_V2);
        d.extend_from_slice(&[0u8; 32]); // write authority
        d.push(1); // Full
        d.extend_from_slice(&[9u8; 32]); // feed id
        d.extend_from_slice(&123i64.to_le_bytes());
        d.extend_from_slice(&4u64.to_le_bytes());
        d.extend_from_slice(&(-8i32).to_le_bytes());
        d.extend_from_slice(&1_700_000_000i64.to_le_bytes());
        d.extend_from_slice(&[0u8; 40]);
        let p = parse_price_update(&d).unwrap();
        assert_eq!((p.price, p.conf, p.exponent, p.publish_time), (123, 4, -8, 1_700_000_000));
        assert_eq!(p.feed_id, [9u8; 32]);

        d[40] = 0; // Partial is rejected
        assert!(parse_price_update(&d).is_none());
        assert!(parse_price_update(&d[..20]).is_none());
    }
}
