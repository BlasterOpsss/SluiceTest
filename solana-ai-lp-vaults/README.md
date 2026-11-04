# solana-ai-lp-vaults

Non-custodial vaults where each user delegates a restricted AI agent to manage
concentrated liquidity (Orca Whirlpools) on **verified tokens only**.

> **Status: pre-alpha, unaudited, uncompiled skeleton. Do not deposit real funds.**

## Layout
- `programs/vault` - Anchor program (vault, guardrails, agent delegation)
- `programs/vault/src/adapters/orca.rs` - Orca CPI wrappers (TODO)
- `agent/` - TypeScript runtime (strategy + deterministic risk engine)
- `registry/verified-tokens.json` - verified mint allowlist
- `docs/MAINNET_CHECKLIST.md` - required steps before mainnet

## Quick start
```bash
anchor build
anchor keys sync          # replaces the placeholder program ID
anchor test               # localnet
cd agent && npm install && npm run typecheck
```

## Security model
- Only the owner can withdraw, and only to their own token accounts.
- The agent key can never transfer funds out; it may only act within guardrails.
- `revoke_agent` and `set_guardrails(paused=true)` are instant owner kill switches.

## Web dashboard (`web/`)
```bash
cd web
cp .env.example .env      # set VITE_PROGRAM_ID and VITE_RPC_URL
npm install
npm run dev               # http://localhost:5173
```
Connect Phantom/Solflare, create a vault, deposit/withdraw, set or revoke the agent, edit guardrails.
