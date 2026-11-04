use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod adapters;
pub mod oracle;

// Placeholder. Run `anchor keys sync` to replace.
declare_id!("3z5BKxv1we9aRjKTXHSkZgqiFmaQbA829yr5P36WZUMJ");

const SECONDS_PER_DAY: i64 = 86_400;
pub const MAX_POOLS: usize = 8;

#[program]
pub mod vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.owner = ctx.accounts.owner.key();
        v.agent = Pubkey::default();
        v.bump = ctx.bumps.vault;

        let g = &mut ctx.accounts.guardrails;
        g.vault = v.key();
        g.max_position_bps = 2_500; // 25% of vault per position
        g.max_slippage_bps = 50; // 0.5%
        g.daily_action_cap = 10;
        g.stop_loss_bps = 1_500; // 15%
        g.paused = false;
        g.actions_today = 0;
        g.day_start = Clock::get()?.unix_timestamp;
        g.bump = ctx.bumps.guardrails;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.owner_token.to_account_info(),
                    to: ctx.accounts.vault_token.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )
    }

    /// Owner-only. Destination must be a token account owned by the owner.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        let owner = ctx.accounts.owner.key();
        let seeds: &[&[u8]] = &[b"vault", owner.as_ref(), &[ctx.accounts.vault.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault_token.to_account_info(),
                    to: ctx.accounts.owner_token.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }

    pub fn set_agent(ctx: Context<OwnerOnly>, agent: Pubkey) -> Result<()> {
        require!(agent != ctx.accounts.owner.key(), VaultError::InvalidAgent);
        require!(agent != Pubkey::default(), VaultError::InvalidAgent);
        ctx.accounts.vault.agent = agent;
        Ok(())
    }

    /// Instant kill switch.
    pub fn revoke_agent(ctx: Context<OwnerOnly>) -> Result<()> {
        ctx.accounts.vault.agent = Pubkey::default();
        Ok(())
    }

    pub fn set_guardrails(ctx: Context<SetGuardrails>, p: GuardrailParams) -> Result<()> {
        require!(
            p.max_position_bps > 0 && p.max_position_bps <= 10_000,
            VaultError::InvalidParams
        );
        require!(p.max_slippage_bps <= 500, VaultError::InvalidParams);
        require!(p.stop_loss_bps <= 10_000, VaultError::InvalidParams);
        require!(p.daily_action_cap > 0, VaultError::InvalidParams);
        let g = &mut ctx.accounts.guardrails;
        g.max_position_bps = p.max_position_bps;
        g.max_slippage_bps = p.max_slippage_bps;
        g.daily_action_cap = p.daily_action_cap;
        g.stop_loss_bps = p.stop_loss_bps;
        g.paused = p.paused;
        Ok(())
    }

    /// Agent checkpoint: enforces pause + daily cap. Orca open/rebalance/close
    /// instructions (see adapters/orca.rs) must run the same logic first.
    pub fn agent_checkpoint(ctx: Context<AgentAction>) -> Result<()> {
        let g = &mut ctx.accounts.guardrails;
        require!(!g.paused, VaultError::Paused);
        let now = Clock::get()?.unix_timestamp;
        if now - g.day_start >= SECONDS_PER_DAY {
            g.day_start = now;
            g.actions_today = 0;
        }
        require!(
            g.actions_today < g.daily_action_cap,
            VaultError::DailyCapReached
        );
        g.actions_today += 1;
        Ok(())
    }

    /// Owner-only: set which Orca whirlpools the agent may use (max 8).
    pub fn set_allowed_pools(ctx: Context<SetAllowedPools>, pools: Vec<Pubkey>) -> Result<()> {
        require!(pools.len() <= MAX_POOLS, VaultError::TooManyPools);
        let a = &mut ctx.accounts.allowed_pools;
        a.vault = ctx.accounts.vault.key();
        a.pools = pools;
        a.bump = ctx.bumps.allowed_pools;
        Ok(())
    }

    /// Owner-only: tie a pool to two Pyth USD feeds. Once set, the agent cannot add
    /// liquidity unless the pool price is within `max_deviation_bps` of the oracle.
    pub fn set_pool_oracle(
        ctx: Context<SetPoolOracle>,
        pool: Pubkey,
        feed_id_a: [u8; 32],
        feed_id_b: [u8; 32],
        max_deviation_bps: u16,
        max_age_secs: u32,
    ) -> Result<()> {
        require!(
            max_deviation_bps > 0 && max_deviation_bps <= 1_000,
            VaultError::InvalidParams
        );
        require!(max_age_secs > 0 && max_age_secs <= 86_400, VaultError::InvalidParams);
        let o = &mut ctx.accounts.pool_oracle;
        o.vault = ctx.accounts.vault.key();
        o.pool = pool;
        o.feed_id_a = feed_id_a;
        o.feed_id_b = feed_id_b;
        o.max_deviation_bps = max_deviation_bps;
        o.max_age_secs = max_age_secs;
        o.bump = ctx.bumps.pool_oracle;
        Ok(())
    }

    /// Agent: open an empty position owned by the vault PDA.
    pub fn orca_open_position(
        ctx: Context<OrcaOpen>,
        tick_lower: i32,
        tick_upper: i32,
    ) -> Result<()> {
        ctx.accounts.guardrails.record_action()?;
        require!(
            ctx.accounts
                .allowed_pools
                .pools
                .contains(&ctx.accounts.whirlpool.key()),
            VaultError::PoolNotAllowed
        );
        require!(tick_lower < tick_upper, VaultError::InvalidParams);
        let (position, bump) = Pubkey::find_program_address(
            &[b"position", ctx.accounts.position_mint.key().as_ref()],
            &adapters::orca::WHIRLPOOL_ID,
        );
        require_keys_eq!(position, ctx.accounts.position.key(), VaultError::InvalidParams);
        adapters::orca::open_position(&ctx.accounts, bump, tick_lower, tick_upper)
    }

    /// Agent: add liquidity. Each token max is capped at max_position_bps of the
    /// vault's balance of that token (per call).
    pub fn orca_increase_liquidity(
        ctx: Context<OrcaLiquidity>,
        liquidity_amount: u128,
        token_max_a: u64,
        token_max_b: u64,
    ) -> Result<()> {
        // Only the agent may ADD liquidity; the owner may only exit.
        require!(
            ctx.accounts.vault.agent == ctx.accounts.agent.key()
                && ctx.accounts.vault.agent != Pubkey::default(),
            VaultError::UnauthorizedAgent
        );
        ctx.accounts.guardrails.record_action()?;
        require!(
            ctx.accounts
                .allowed_pools
                .pools
                .contains(&ctx.accounts.whirlpool.key()),
            VaultError::PoolNotAllowed
        );
        let bps = ctx.accounts.guardrails.max_position_bps as u128;
        let cap = |bal: u64| ((bal as u128) * bps / 10_000) as u64;
        require!(
            token_max_a <= cap(ctx.accounts.token_owner_account_a.amount)
                && token_max_b <= cap(ctx.accounts.token_owner_account_b.amount),
            VaultError::PositionTooLarge
        );
        oracle::check(
            ctx.program_id,
            &ctx.accounts.vault.key(),
            &ctx.accounts.whirlpool.to_account_info(),
            ctx.remaining_accounts,
        )?;
        adapters::orca::liquidity(
            adapters::orca::INCREASE_LIQUIDITY,
            liquidity_amount,
            token_max_a,
            token_max_b,
            &ctx.accounts,
        )
    }

    /// Agent: remove liquidity. Proceeds go to the vault's own token accounts.
    pub fn orca_decrease_liquidity(
        ctx: Context<OrcaLiquidity>,
        liquidity_amount: u128,
        token_min_a: u64,
        token_min_b: u64,
    ) -> Result<()> {
        // Exits are never blocked by the pause flag or the daily cap.
        // Proceeds only go to vault-owned accounts, so no allowlist check is needed.
        adapters::orca::liquidity(
            adapters::orca::DECREASE_LIQUIDITY,
            liquidity_amount,
            token_min_a,
            token_min_b,
            &ctx.accounts,
        )
    }

    /// Agent: close an empty position. Rent refund goes to the agent.
    /// Closing is allowed even while paused, so positions can always be exited.
    pub fn orca_close_position(ctx: Context<OrcaClose>) -> Result<()> {
        adapters::orca::close_position(&ctx.accounts)
    }

    /// Agent: collect earned fees into the vault's own token accounts.
    pub fn orca_collect_fees(ctx: Context<OrcaCollect>) -> Result<()> {
        adapters::orca::collect_fees(&ctx.accounts)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct GuardrailParams {
    pub max_position_bps: u16,
    pub max_slippage_bps: u16,
    pub daily_action_cap: u8,
    pub stop_loss_bps: u16,
    pub paused: bool,
}

#[account]
#[derive(InitSpace)]
pub struct UserVault {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Guardrails {
    pub vault: Pubkey,
    pub max_position_bps: u16,
    pub max_slippage_bps: u16,
    pub daily_action_cap: u8,
    pub stop_loss_bps: u16,
    pub paused: bool,
    pub actions_today: u8,
    pub day_start: i64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + UserVault::INIT_SPACE,
        seeds = [b"vault", owner.key().as_ref()], bump)]
    pub vault: Account<'info, UserVault>,
    #[account(init, payer = owner, space = 8 + Guardrails::INIT_SPACE,
        seeds = [b"guardrails", vault.key().as_ref()], bump)]
    pub guardrails: Account<'info, Guardrails>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, UserVault>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = owner,
        associated_token::mint = mint, associated_token::authority = vault)]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, UserVault>,
    pub mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = vault)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, UserVault>,
}

#[derive(Accounts)]
pub struct SetGuardrails<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, UserVault>,
    #[account(mut, seeds = [b"guardrails", vault.key().as_ref()], bump = guardrails.bump)]
    pub guardrails: Account<'info, Guardrails>,
}

#[derive(Accounts)]
pub struct AgentAction<'info> {
    pub agent: Signer<'info>,
    #[account(seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump,
        constraint = vault.agent == agent.key() && vault.agent != Pubkey::default()
            @ VaultError::UnauthorizedAgent)]
    pub vault: Account<'info, UserVault>,
    #[account(mut, seeds = [b"guardrails", vault.key().as_ref()], bump = guardrails.bump)]
    pub guardrails: Account<'info, Guardrails>,
}

#[derive(Accounts)]
pub struct OrcaCollect<'info> {
    pub agent: Signer<'info>,
    #[account(seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump,
        constraint = (vault.agent == agent.key() && vault.agent != Pubkey::default())
            || vault.owner == agent.key() @ VaultError::UnauthorizedAgent)]
    pub vault: Account<'info, UserVault>,
    /// CHECK: validated by the Whirlpool program (must match the position).
    #[account(mut)]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: validated by the Whirlpool program.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    #[account(token::authority = vault, constraint = position_token_account.amount == 1
        @ VaultError::InvalidParams)]
    pub position_token_account: Account<'info, TokenAccount>,
    /// Fees only ever go to vault-owned token accounts.
    #[account(mut, token::authority = vault)]
    pub token_owner_account_a: Account<'info, TokenAccount>,
    #[account(mut, token::authority = vault)]
    pub token_owner_account_b: Account<'info, TokenAccount>,
    /// CHECK: pool's token vault, validated by the Whirlpool program.
    #[account(mut)]
    pub token_vault_a: UncheckedAccount<'info>,
    /// CHECK: pool's token vault, validated by the Whirlpool program.
    #[account(mut)]
    pub token_vault_b: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: pinned to the official Whirlpool program ID.
    #[account(address = adapters::orca::WHIRLPOOL_ID)]
    pub whirlpool_program: UncheckedAccount<'info>,
}

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Invalid agent key")]
    InvalidAgent,
    #[msg("Invalid guardrail parameters")]
    InvalidParams,
    #[msg("Vault is paused")]
    Paused,
    #[msg("Daily action cap reached")]
    DailyCapReached,
    #[msg("Signer is not the vault's agent")]
    UnauthorizedAgent,
    #[msg("Whirlpool is not in the vault allowlist")]
    PoolNotAllowed,
    #[msg("Too many allowed pools")]
    TooManyPools,
    #[msg("Amount exceeds max position size")]
    PositionTooLarge,
    #[msg("Oracle accounts missing")]
    OracleAccountsMissing,
    #[msg("Bad oracle account")]
    OracleBadAccount,
    #[msg("Oracle price is stale")]
    OracleStale,
    #[msg("Pool price deviates too far from oracle")]
    OracleDeviation,
    #[msg("Oracle math error")]
    OracleMath,
}
impl Guardrails {
    /// Pause check + daily action cap (same logic as agent_checkpoint).
    pub fn record_action(&mut self) -> Result<()> {
        require!(!self.paused, VaultError::Paused);
        let now = Clock::get()?.unix_timestamp;
        if now - self.day_start >= SECONDS_PER_DAY {
            self.day_start = now;
            self.actions_today = 0;
        }
        require!(self.actions_today < self.daily_action_cap, VaultError::DailyCapReached);
        self.actions_today += 1;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct PoolOracle {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub feed_id_a: [u8; 32],
    pub feed_id_b: [u8; 32],
    pub max_deviation_bps: u16,
    pub max_age_secs: u32,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(pool: Pubkey)]
pub struct SetPoolOracle<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, UserVault>,
    #[account(init_if_needed, payer = owner, space = 8 + PoolOracle::INIT_SPACE,
        seeds = [b"oracle", vault.key().as_ref(), pool.as_ref()], bump)]
    pub pool_oracle: Account<'info, PoolOracle>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct AllowedPools {
    pub vault: Pubkey,
    #[max_len(8)]
    pub pools: Vec<Pubkey>,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct SetAllowedPools<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, UserVault>,
    #[account(init_if_needed, payer = owner, space = 8 + AllowedPools::INIT_SPACE,
        seeds = [b"pools", vault.key().as_ref()], bump)]
    pub allowed_pools: Account<'info, AllowedPools>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OrcaOpen<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump,
        constraint = vault.agent == agent.key() && vault.agent != Pubkey::default()
            @ VaultError::UnauthorizedAgent)]
    pub vault: Account<'info, UserVault>,
    #[account(mut, seeds = [b"guardrails", vault.key().as_ref()], bump = guardrails.bump)]
    pub guardrails: Account<'info, Guardrails>,
    #[account(seeds = [b"pools", vault.key().as_ref()], bump = allowed_pools.bump)]
    pub allowed_pools: Account<'info, AllowedPools>,
    /// CHECK: must be in allowed_pools; validated by the Whirlpool program.
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: PDA of the position mint, derived and checked in the handler.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// New position NFT mint; must sign the transaction.
    #[account(mut)]
    pub position_mint: Signer<'info>,
    /// CHECK: vault's ATA for the position mint, created by the Whirlpool program.
    #[account(mut)]
    pub position_token_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: pinned to the official Whirlpool program ID.
    #[account(address = adapters::orca::WHIRLPOOL_ID)]
    pub whirlpool_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OrcaLiquidity<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump,
        constraint = (vault.agent == agent.key() && vault.agent != Pubkey::default())
            || vault.owner == agent.key() @ VaultError::UnauthorizedAgent)]
    pub vault: Account<'info, UserVault>,
    #[account(mut, seeds = [b"guardrails", vault.key().as_ref()], bump = guardrails.bump)]
    pub guardrails: Account<'info, Guardrails>,
    #[account(seeds = [b"pools", vault.key().as_ref()], bump = allowed_pools.bump)]
    pub allowed_pools: Account<'info, AllowedPools>,
    /// CHECK: must be in allowed_pools; validated by the Whirlpool program.
    #[account(mut)]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: validated by the Whirlpool program (belongs to whirlpool and the NFT).
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// The vault must hold the position NFT.
    #[account(token::authority = vault, constraint = position_token_account.amount == 1
        @ VaultError::InvalidParams)]
    pub position_token_account: Account<'info, TokenAccount>,
    /// Funds only ever move to/from vault-owned token accounts.
    #[account(mut, token::authority = vault)]
    pub token_owner_account_a: Account<'info, TokenAccount>,
    #[account(mut, token::authority = vault)]
    pub token_owner_account_b: Account<'info, TokenAccount>,
    /// CHECK: pool's token vault, validated by the Whirlpool program.
    #[account(mut)]
    pub token_vault_a: UncheckedAccount<'info>,
    /// CHECK: pool's token vault, validated by the Whirlpool program.
    #[account(mut)]
    pub token_vault_b: UncheckedAccount<'info>,
    /// CHECK: validated by the Whirlpool program.
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: validated by the Whirlpool program.
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: pinned to the official Whirlpool program ID.
    #[account(address = adapters::orca::WHIRLPOOL_ID)]
    pub whirlpool_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OrcaClose<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump,
        constraint = (vault.agent == agent.key() && vault.agent != Pubkey::default())
            || vault.owner == agent.key() @ VaultError::UnauthorizedAgent)]
    pub vault: Account<'info, UserVault>,
    /// CHECK: validated by the Whirlpool program.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: validated by the Whirlpool program.
    #[account(mut)]
    pub position_mint: UncheckedAccount<'info>,
    #[account(mut, token::authority = vault, constraint = position_token_account.amount == 1
        @ VaultError::InvalidParams)]
    pub position_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    /// CHECK: pinned to the official Whirlpool program ID.
    #[account(address = adapters::orca::WHIRLPOOL_ID)]
    pub whirlpool_program: UncheckedAccount<'info>,
}

