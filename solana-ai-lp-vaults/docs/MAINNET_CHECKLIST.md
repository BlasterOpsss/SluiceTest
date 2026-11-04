# Mainnet checklist (all required)
- [ ] `anchor build` + tests pass; Orca CPI implemented and tested on devnet
- [ ] On-chain Pyth price/slippage checks added
- [ ] Independent audit complete; report in `/audits`; findings fixed
- [ ] Upgrade authority moved to a Squads multisig
- [ ] Token registry controlled by multisig
- [ ] Per-vault and global deposit caps for the beta
- [ ] Legal review (managed-funds / securities rules in your jurisdiction)
- [ ] Monitoring + incident runbook

## Deploy (only after the above)
```bash
solana config set --url mainnet-beta
anchor build && anchor keys sync
anchor deploy --provider.cluster mainnet
solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <SQUADS_VAULT>
```

## Orca integration status
- Implemented (uncompiled/untested): set_allowed_pools, orca_open_position,
  orca_increase_liquidity, orca_decrease_liquidity, orca_close_position
- Implemented (uncompiled/untested): on-chain Pyth deviation check (set_pool_oracle);
  owner opts in per pool. MAINNET: configure an oracle for EVERY allowed pool.
- Missing: on-chain verified-mint registry, mandatory-oracle flag, cumulative
  position cap, web UI for allowed pools / oracle config

## Pyth oracle check (added)
- `set_pool_oracle` (owner): ties a pool to two Pyth USD feeds, max deviation (<=10%), max age.
- `orca_increase_liquidity` enforces: Pyth Receiver-owned accounts, Full verification,
  matching feed IDs, freshness, confidence, and pool price within the deviation limit.
- **If no oracle is configured for a pool, the check is skipped.** Configure one for
  every allowed pool before mainnet (and use max_age of ~60s, not the devnet test value).
- Decrease/close are never oracle-gated so positions can always be exited.
